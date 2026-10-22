import { SinkViewSchema, type TargetPutRequest } from '@ih/bridge-contract';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_TARGET_ID,
  normalisePrefix,
  publishTargetIdFrom,
  PublishTargetViewSchema,
  TargetChoiceSchema,
  TargetConnectionSchema,
  SinkTargetCreateBodySchema,
  SinkTargetPatchBodySchema,
  TargetCreateBodySchema,
  TargetPatchBodySchema,
  TargetTestBodySchema,
  TargetTestResultSchema,
  targetInUse,
  type PublishTargetView,
  type TargetConnection,
  type TargetPatchBody,
  type TargetUsage,
} from '@ih/shared';
import { z } from 'zod';
import { BridgeApiError } from '../bridge/client.js';
import { error, md, noContent, res } from '../openapi/zod.js';
import {
  INTERNAL_CONNECTION_ID,
  S3_SINK_ID,
  s3Destination,
  s3OptionsOf,
  s3PlaceOf,
} from '../publish-targets/place.js';
import type { TargetRecord } from '../publish-targets/repo.js';

const ADMINS_ONLY = error('`admins only`.');
const NOT_FOUND_MESSAGE = 'publishing target not found';
const NOT_FOUND = error(`\`${NOT_FOUND_MESSAGE}\`.`);
const BRIDGE_DOWN = 'the delivery bridge could not be reached';
const CACHE_FAILED = 'saved on the bridge; refresh';
const REMOVED_ON_BRIDGE = 'removed on the bridge; remove again';
const IdParams = z.object({ id: z.string().describe('The publishing target id.') });
const LOCKED = ['bucket', 'prefix', 'layout'] as const;
const base = (operationId: string, summary: string, description: string) => ({
  tags: ['Published outputs'],
  'x-admin': true,
  operationId,
  summary,
  description,
});

/** What uses a target, for a 409: up to three document types, else outputs and consumers. */
export function usageText(u: TargetUsage): string {
  if (u.documentTypes.length > 0) {
    const named = u.documentTypes.slice(0, 3).join(', ');
    const more = u.documentTypes.length - 3;
    return more > 0 ? `${named} and ${more} more` : named;
  }
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return [
    ...(u.deliveredOutputs > 0 ? [plural(u.deliveredOutputs, 'delivered output')] : []),
    ...(u.consumers > 0 ? [plural(u.consumers, 'S3 key consumer')] : []),
    ...(u.pendingJobs > 0 ? [plural(u.pendingJobs, 'pending withdrawal')] : []),
  ].join(' and ');
}

const issuesOf = (e: z.ZodError) => e.issues;

const OWN_BUCKET =
  "`{bucket} is CT Studio's own {inbox|outputs|runs|backups} bucket: pick another`, or " +
  "`{bucket} is the delivery bridge's staging bucket: pick another`";

/**
 * Which of the deployment's own buckets an internal target would name, else null. The bridge's
 * staging bucket holds every package it delivers: a data-lake key granted on a target there
 * would read them all.
 */
function ownBucketProblem(
  target: { kind: string; bucket: string },
  deps: {
    buckets: { inbox: string; outputs: string; runs: string; backups: string };
    bridgeStagingBucket: string;
  },
): string | null {
  if (target.kind !== 'internal') return null;
  if (target.bucket === deps.bridgeStagingBucket) {
    return `${target.bucket} is the delivery bridge's staging bucket: pick another`;
  }
  const which = (['inbox', 'outputs', 'runs', 'backups'] as const).find(
    (k) => deps.buckets[k] === target.bucket,
  );
  return which ? `${target.bucket} is CT Studio's own ${which} bucket: pick another` : null;
}

/** An S3 target's settings as an admin edits them (its destination, read or about to be written). */
interface Settings {
  label: string;
  kind: 'internal' | 'external';
  bucket: string;
  prefix: string;
  layout: 'files' | 'package';
  connectionId: string | null;
  sse: 'none' | 'AES256' | 'aws:kms';
  kmsKeyId: string | null;
  storageClass: string | null;
}

/** A cached S3 target's settings; null for the triple store and other sinks. */
function settingsOf(r: TargetRecord): Settings | null {
  const place = s3PlaceOf(r);
  const options = s3OptionsOf(r);
  if (!place || !options || (r.kind !== 'internal' && r.kind !== 'external')) return null;
  return {
    label: r.label,
    kind: r.kind,
    ...place,
    connectionId: r.kind === 'internal' ? null : r.connectionId,
    ...options,
  };
}

/** What the bridge is sent for these settings: internal targets use the built-in connection. */
function putOf(s: Settings): TargetPutRequest {
  return {
    label: s.label,
    sinkId: S3_SINK_ID,
    instanceId: null,
    connectionId: s.kind === 'internal' ? INTERNAL_CONNECTION_ID : s.connectionId,
    destination: s3Destination(s),
  };
}

/** A cached target written back to the bridge as it is (bar what `over` changes). */
const putOfRecord = (r: TargetRecord, over: Partial<TargetPutRequest> = {}): TargetPutRequest => ({
  label: r.label,
  sinkId: r.sinkId,
  instanceId: r.instanceId,
  connectionId: r.connectionId,
  destination: r.destination,
  ...over,
});

/**
 * The stored settings overlaid with a patch, in create-body shape: `null` clears a field, and
 * the KMS key goes whenever the resulting encryption is not KMS (unless the patch names one,
 * which the create rules then refuse).
 */
function overlay(stored: Settings, patch: Record<string, unknown>): Record<string, unknown> {
  const shape: Record<string, unknown> = { ...createShape(stored) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete shape[k];
    else if (v !== undefined) shape[k] = v;
  }
  if (shape.sse !== 'aws:kms' && patch.kmsKeyId === undefined) delete shape.kmsKeyId;
  return shape;
}

/** The stored settings in create-body shape, so an overlay can be checked with the create rules. */
function createShape(t: Settings): Record<string, unknown> {
  const shape: Record<string, unknown> = {
    label: t.label,
    kind: t.kind,
    bucket: t.bucket,
    prefix: t.prefix,
    layout: t.layout,
  };
  if (t.kind === 'internal') return shape;
  return {
    ...shape,
    ...(t.connectionId ? { connectionId: t.connectionId } : {}),
    sse: t.sse,
    ...(t.kmsKeyId ? { kmsKeyId: t.kmsKeyId } : {}),
    ...(t.storageClass ? { storageClass: t.storageClass } : {}),
  };
}

/** Settings checked with the create rules. */
function settingsFrom(
  b: z.infer<typeof TargetCreateBodySchema>,
  stored: Settings | null,
): Settings {
  const external = b.kind === 'external';
  return {
    label: b.label,
    kind: b.kind,
    bucket: b.bucket,
    // A stored prefix kept as it is (`default` is seeded verbatim from `.env`); a new one normalised.
    prefix: stored && b.prefix === stored.prefix ? stored.prefix : normalisePrefix(b.prefix),
    layout: b.layout,
    connectionId: external ? (b.connectionId ?? null) : null,
    sse: external ? b.sse : 'none',
    kmsKeyId: external ? (b.kmsKeyId ?? null) : null,
    storageClass: external ? (b.storageClass ?? null) : null,
  };
}

/** A bridge failure as this API answers it: 422 with the bridge's message, else 502. */
function bridgeFailure(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof BridgeApiError && err.needsUser && err.error) {
    return reply.code(422).send({ error: err.error.message });
  }
  return reply.code(502).send({ error: BRIDGE_DOWN });
}

/**
 * Publishing targets (Administration > Published outputs): where recipes deliver. Admins only,
 * except the picker's choices (any designer or admin; the access hook refuses operators). The
 * access hook has already required a session (`deps.access === null` disables both in unit
 * tests). No credential is accepted or returned: an external target names a shared connection
 * of the delivery bridge, whose keys are managed on the bridge's connections page. Every write
 * goes to the bridge first; the cache then takes the bridge's answer.
 */
export async function publishTargetRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/publish-targets/choices',
    {
      schema: {
        tags: ['Published outputs'],
        operationId: 'listPublishTargetChoices',
        summary: 'List the publishing targets a recipe may name',
        description: md`
          What the recipe editor's _Publish to_ picker offers: each target's id, label, kind and
          bucket, the default first, then by label. No endpoints or credentials.
        `,
        response: {
          200: res('The choices.', z.object({ choices: z.array(TargetChoiceSchema) })),
        },
      },
    },
    async () => {
      const sinks = app.deps.sinks!;
      const choices = await app.deps.targets.choices();
      if (choices.some((c) => c.kind === 'sink')) await sinks.refresh(app.deps.bridge);
      const sinkIds = new Map((await app.deps.targets.list()).map((v) => [v.id, v.sinkId]));
      return {
        choices: choices.map((c) =>
          c.kind === 'sink'
            ? { ...c, sinkName: sinks.get(sinkIds.get(c.id) ?? '')?.name ?? null }
            : c,
        ),
      };
    },
  );

  await app.register(adminRoutes);
}

async function adminRoutes(app: FastifyInstance): Promise<void> {
  const repo = app.deps.targets;
  const stores = app.deps.targetStores;
  const bridge = app.deps.bridge;
  const sinks = app.deps.sinks!;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  });

  const by = (req: FastifyRequest) => req.auth?.label ?? null;
  /** Creates an internal target's bucket; the error message, else null. */
  const bucketProblem = async (target: Settings): Promise<string | null> => {
    if (target.kind !== 'internal') return null;
    try {
      await stores.ensureBucket({
        kind: target.kind,
        sinkId: S3_SINK_ID,
        destination: s3Destination(target),
      });
      return null;
    } catch (err) {
      return `could not create bucket ${target.bucket}: ${(err as Error).message}`;
    }
  };
  /** The bridge's shared S3 and triple store connections by id; empty when it cannot be reached. */
  const connections = async (): Promise<
    Map<string, { connection: TargetConnection; fields: Record<string, string> }>
  > => {
    try {
      const listed = await bridge.listConnections('shared');
      return new Map(
        listed
          // Every shared connection: S3, the triple store's, and those of other sinks' targets.
          .map((c) => [
            c.id,
            {
              connection: {
                id: c.id,
                name: c.name,
                status: c.status,
                statusReason: c.statusReason,
              },
              fields: c.fields,
            },
          ]),
      );
    } catch (err) {
      app.log.warn({ err }, 'the bridge could not list its connections');
      return new Map();
    }
  };
  /**
   * The views with their connections as the bridge describes them; the triple store's endpoint
   * is its connection's (null when the bridge cannot say).
   */
  const withConnections = async (views: PublishTargetView[]): Promise<PublishTargetView[]> => {
    if (views.some((v) => v.kind === 'sink')) await sinks.refresh(bridge);
    const named = views.map((v) => {
      if (v.kind !== 'sink') return v;
      const sink = sinks.get(v.sinkId);
      return { ...v, sinkName: sink?.name ?? null, deliverOnly: !sink?.capabilities.withdraw };
    });
    if (!named.some((v) => v.connectionId)) return named;
    const known = await connections();
    return named.map((v) => {
      const found = v.connectionId ? known.get(v.connectionId) : undefined;
      return {
        ...v,
        connection: found?.connection ?? null,
        endpoint: v.kind === 'rdf' ? (found?.fields.endpoint ?? null) : v.endpoint,
      };
    });
  };
  /**
   * Caches the bridge's answer after it accepted a write. A failure leaves the bridge ahead of
   * the cache: the admin is told to refresh, and the next pull heals it. Null when cached.
   */
  const cacheAnswer = async (
    view: Parameters<typeof repo.cache>[0],
    facts: Parameters<typeof repo.cache>[1],
    reply: FastifyReply,
    log: FastifyRequest['log'],
  ): Promise<FastifyReply | null> => {
    try {
      await repo.cache(view, facts);
      return null;
    } catch (err) {
      log.error({ err, target: view.id }, 'the bridge accepted a target the cache could not store');
      return reply.code(500).send({ error: CACHE_FAILED });
    }
  };
  /** One target's view as the list shows it (after a write). */
  const viewOf = async (id: string): Promise<PublishTargetView | undefined> =>
    (await withConnections((await repo.list()).filter((v) => v.id === id)))[0];
  /** Every id the cache holds, inert ones too: an inert id stays taken. */
  const taken = async (): Promise<Set<string>> =>
    new Set((await repo.cachedIds()).map((c) => c.id));

  app.get(
    '/publish-targets',
    {
      schema: {
        ...base(
          'listPublishTargets',
          'List publishing targets',
          md`
            **Admins only.** Every publishing target with what uses it (\`usage\`: published
            recipe versions naming it, delivered outputs and graph copies recording it, S3 key
            consumers granted it). The \`default\` target is seeded from \`.env\` on first start.
            An external target names the delivery bridge's connection holding its keys
            (\`connection\`: its name and status, null when the bridge cannot say); no credential
            is ever returned.
          `,
        ),
        response: {
          200: res('The targets.', z.object({ targets: z.array(PublishTargetViewSchema) })),
          403: ADMINS_ONLY,
        },
      },
    },
    async () => ({ targets: await withConnections(await repo.list()) }),
  );

  app.get(
    '/publish-targets/sinks',
    {
      schema: {
        ...base(
          'listSinks',
          'List the sinks',
          md`
            **Admins only.** The delivery bridge's sinks (the built-in S3 and triple store, and
            every registered external sink): name, status, contract version, connection kind,
            instances, the fields a target and a connection of it take (never values), and
            capabilities. An external sink is deliver-only for now. When the bridge cannot be
            reached, the sinks it last listed.
          `,
        ),
        response: {
          200: res('The sinks.', z.object({ sinks: z.array(SinkViewSchema) })),
          403: ADMINS_ONLY,
        },
      },
    },
    async () => {
      await sinks.refresh(bridge);
      return { sinks: sinks.all() };
    },
  );

  app.get(
    '/publish-targets/connections',
    {
      schema: {
        ...base(
          'listPublishTargetConnections',
          'List the connections a target may use',
          md`
            **Admins only.** The delivery bridge's shared S3 connections (name and status, never
            a credential), for the external target editor's picker. The built-in connection of
            internal targets is not offered. 502 when the bridge cannot be reached.
          `,
        ),
        response: {
          200: res('The connections.', z.object({ connections: z.array(TargetConnectionSchema) })),
          403: ADMINS_ONLY,
          502: error(`\`${BRIDGE_DOWN}\`.`),
        },
      },
    },
    async (_req, reply) => {
      try {
        const listed = await bridge.listConnections('shared');
        return {
          connections: listed
            .filter((c) => c.sinkId === 's3' && c.id !== INTERNAL_CONNECTION_ID)
            .map((c) => ({
              id: c.id,
              name: c.name,
              status: c.status,
              statusReason: c.statusReason,
            })),
        };
      } catch {
        return reply.code(502).send({ error: BRIDGE_DOWN });
      }
    },
  );

  app.post(
    '/publish-targets',
    {
      schema: {
        ...base(
          'createPublishTarget',
          'Add a publishing target',
          md`
            **Admins only.** An internal target (a bucket on this deployment's SeaweedFS, whose
            bucket is created here when missing) or an external S3 bucket reached with one of
            the delivery bridge's shared connections (\`connectionId\`). The id is made from
            the label when not given (\`-2\`, \`-3\`… when taken); \`default\` is reserved. Use the
            same id on every deployment for the same recipient: recipes carry it. The target is
            written to the bridge first and this deployment caches the bridge's answer; when the
            bridge refuses it (422, its message) or cannot be reached (502), nothing is stored.
            When only the cache write fails (500), the bridge has the target: refresh. No credential is accepted here.
          `,
        ),
        body: z.union([TargetCreateBodySchema, SinkTargetCreateBodySchema]),
        response: {
          201: res('The target.', PublishTargetViewSchema),
          400: error(`Zod issues, \`default is reserved\`, or ${OWN_BUCKET}.`),
          403: ADMINS_ONLY,
          409: error('`a publishing target {id} already exists`.'),
          422: error("The bridge's refusal, e.g. `there is no connection {id}`."),
          500: error(`\`${CACHE_FAILED}\`: the bridge has it; the next refresh caches it.`),
          502: error(
            `\`could not create bucket {bucket}: {message}\`, or \`${BRIDGE_DOWN}\`; nothing is stored.`,
          ),
        },
      },
    },
    async (req, reply) => {
      if ((req.body as { kind?: unknown } | undefined)?.kind === 'sink') {
        return createSinkTarget(req, reply);
      }
      const body = TargetCreateBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: issuesOf(body.error) });
      const b = body.data;
      if (b.id === DEFAULT_TARGET_ID) return reply.code(400).send({ error: 'default is reserved' });
      let id = b.id;
      const ids = await taken();
      if (id === undefined) {
        const stem = publishTargetIdFrom(b.label);
        id = stem;
        for (let n = 2; ids.has(id); n++) id = `${stem}-${n}`;
      } else if (ids.has(id)) {
        return reply.code(409).send({ error: `a publishing target ${id} already exists` });
      }
      const settings = settingsFrom(b, null);
      const own = ownBucketProblem(settings, app.deps);
      if (own) return reply.code(400).send({ error: own });
      const problem = await bucketProblem(settings);
      if (problem) return reply.code(502).send({ error: problem });
      let view;
      try {
        // The bridge first: a target it refuses is not kept here either.
        view = await bridge.putTarget(id, putOf(settings));
      } catch (err) {
        return bridgeFailure(reply, err);
      }
      const failed = await cacheAnswer(view, { source: 'ui', by: by(req) }, reply, req.log);
      if (failed) return failed;
      req.log.info({ target: id, kind: settings.kind }, 'publishing target added');
      return reply.code(201).send(await viewOf(id));
    },
  );

  /** A new id from `label` (or `wanted`): null when `wanted` is taken. */
  const newId = async (label: string, wanted: string | undefined): Promise<string | null> => {
    const ids = await taken();
    if (wanted !== undefined) return ids.has(wanted) ? null : wanted;
    const stem = publishTargetIdFrom(label);
    let id = stem;
    for (let n = 2; ids.has(id); n++) id = `${stem}-${n}`;
    return id;
  };

  /** A target of an external sink: the bridge checks its fields against the sink's. */
  const createSinkTarget = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = SinkTargetCreateBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: issuesOf(body.error) });
    const b = body.data;
    if (b.id === DEFAULT_TARGET_ID) return reply.code(400).send({ error: 'default is reserved' });
    const id = await newId(b.label, b.id);
    if (id === null) {
      return reply.code(409).send({ error: `a publishing target ${b.id} already exists` });
    }
    let view;
    try {
      view = await bridge.putTarget(id, {
        label: b.label,
        sinkId: b.sinkId,
        instanceId: b.instanceId,
        connectionId: b.connectionId,
        destination: b.destination,
      });
    } catch (err) {
      return bridgeFailure(reply, err);
    }
    const failed = await cacheAnswer(view, { source: 'ui', by: by(req) }, reply, req.log);
    if (failed) return failed;
    req.log.info({ target: id, sink: b.sinkId }, 'publishing target added');
    return reply.code(201).send(await viewOf(id));
  };

  /**
   * A sink target's change. While it is in use its fixed fields lock (any field, when the sink
   * is not known now); its label, connection and pattern fields never do.
   */
  const patchSinkTarget = async (
    stored: TargetRecord,
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const body = SinkTargetPatchBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: issuesOf(body.error) });
    const patch = body.data;
    const next = {
      label: patch.label ?? stored.label,
      sinkId: stored.sinkId,
      instanceId: stored.instanceId,
      connectionId: patch.connectionId === undefined ? stored.connectionId : patch.connectionId,
      destination: patch.destination ?? stored.destination,
    };
    if (patch.destination) {
      await sinks.refresh(bridge);
      const fields = sinks.get(stored.sinkId)?.destinationFields;
      const isPattern = (k: string) => fields?.find((f) => f.id === k)?.kind === 'pattern';
      const keys = new Set([...Object.keys(stored.destination), ...Object.keys(next.destination)]);
      const changed = [...keys].filter(
        (k) => !isPattern(k) && stored.destination[k] !== next.destination[k],
      );
      if (changed.length > 0) {
        const usage = await repo.usage(stored.id);
        if (targetInUse(usage)) {
          const label = fields?.find((f) => f.id === changed[0])?.label ?? changed[0];
          return reply.code(409).send({
            error: `${label} of ${stored.label} is locked: ${stored.label} is used by ${usageText(usage)}; add a new target instead`,
          });
        }
      }
    }
    let view;
    try {
      view = await bridge.putTarget(stored.id, next);
    } catch (err) {
      return bridgeFailure(reply, err);
    }
    const failed = await cacheAnswer(view, { by: by(req) }, reply, req.log);
    if (failed) return failed;
    req.log.info({ target: stored.id, fields: Object.keys(patch) }, 'publishing target changed');
    return viewOf(stored.id);
  };

  /** The triple store target (seeded from RDF_ENDPOINT): its label alone changes. */
  const patchTripleStore = async (
    stored: TargetRecord,
    patch: TargetPatchBody,
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (Object.keys(patch).some((k) => k !== 'label') || patch.label === undefined) {
      return reply.code(400).send({ error: 'the triple store target takes a label only' });
    }
    let view;
    try {
      view = await bridge.putTarget(stored.id, putOfRecord(stored, { label: patch.label }));
    } catch (err) {
      return bridgeFailure(reply, err);
    }
    const failed = await cacheAnswer(view, { by: by(req) }, reply, req.log);
    if (failed) return failed;
    req.log.info({ target: stored.id }, 'triple store target renamed');
    return viewOf(stored.id);
  };

  app.patch<{ Params: { id: string } }>(
    '/publish-targets/:id',
    {
      schema: {
        ...base(
          'updatePublishTarget',
          'Change a publishing target',
          md`
            **Admins only.** Fields left out are kept; \`null\` clears the KMS key or storage
            class, and the KMS key is cleared whenever the encryption is not \`aws:kms\`. An
            internal target cannot move onto CT Studio's own inbox, outputs, runs or backups
            bucket (400). While the target is in use (a published recipe version names it, an
            output or graph copy was delivered to it, an S3 key consumer is granted it, or a
            withdrawal still to run names it) its bucket and prefix cannot change (409): add a
            new target and publish a version naming it instead. The label, connection,
            encryption and storage class may always change, so keys are rotated without a new
            version. The change is written to the bridge first and the cache takes its answer;
            when the bridge refuses it (422) or cannot be reached (502), the target is left as it
            was. When only the cache write fails (500), the bridge has the change: refresh.
          `,
        ),
        params: IdParams,
        body: z.union([TargetPatchBodySchema, SinkTargetPatchBodySchema]),
        response: {
          200: res('The target.', PublishTargetViewSchema),
          400: error(`Zod issues, or ${OWN_BUCKET}.`),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('`{label} is used by {what}: add a new target instead`.'),
          422: error("The bridge's refusal, e.g. `there is no connection {id}`."),
          500: error(`\`${CACHE_FAILED}\`: the bridge has it; the next refresh caches it.`),
          502: error(
            `\`could not create bucket {bucket}: {message}\`, or \`${BRIDGE_DOWN}\`; nothing is changed.`,
          ),
        },
      },
    },
    async (req, reply) => {
      const found = await repo.get(req.params.id);
      if (found?.kind === 'sink') return patchSinkTarget(found, req, reply);
      const body = TargetPatchBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: issuesOf(body.error) });
      const patch = body.data;
      const stored = found;
      if (!stored) return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
      if (stored.kind === 'rdf') return patchTripleStore(stored, patch, req, reply);

      const current = settingsOf(stored);
      if (!current) {
        return reply.code(400).send({ error: `${stored.label} is not an S3 target` });
      }
      const merged = TargetCreateBodySchema.safeParse(overlay(current, patch));
      if (!merged.success) return reply.code(400).send({ error: issuesOf(merged.error) });
      const next = settingsFrom(merged.data, current);
      if (patch.bucket !== undefined) {
        const own = ownBucketProblem(next, app.deps);
        if (own) return reply.code(400).send({ error: own });
      }

      const changed = LOCKED.filter((k) => patch[k] !== undefined && next[k] !== current[k]);
      if (changed.length > 0) {
        const usage = await repo.usage(stored.id);
        if (targetInUse(usage)) {
          return reply.code(409).send({
            error: `${stored.label} is used by ${usageText(usage)}: add a new target instead`,
          });
        }
      }
      if (next.bucket !== current.bucket) {
        const problem = await bucketProblem(next);
        if (problem) return reply.code(502).send({ error: problem });
      }

      let view;
      try {
        // The bridge first: a change it refuses leaves the target as it was.
        view = await bridge.putTarget(stored.id, putOf(next));
      } catch (err) {
        return bridgeFailure(reply, err);
      }
      const failed = await cacheAnswer(view, { by: by(req) }, reply, req.log);
      if (failed) return failed;
      const fields = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
      req.log.info({ target: stored.id, fields }, 'publishing target changed');
      return viewOf(stored.id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/publish-targets/:id',
    {
      schema: {
        ...base(
          'deletePublishTarget',
          'Remove a publishing target',
          md`
            **Admins only.** Only a target nothing uses: no published recipe version names it,
            nothing was delivered to it, no S3 key consumer is granted it and no withdrawal still
            to run names it. The \`default\` target is never removed. It is removed from the
            bridge first: one the bridge still has unfinished deliveries for stays (409), and
            nothing is removed while the bridge cannot be reached (502). A removed target is kept
            inert, never deleted: finished delivery records still name it, and its id is not
            used again (a new target with the same label gets \`<id>-2\`).
          `,
        ),
        params: IdParams,
        response: {
          204: noContent('Removed.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error(
            '`default cannot be removed`, `{label} is used by {what}`, or `{label} has deliveries on the bridge`.',
          ),
          500: error(
            `\`${REMOVED_ON_BRIDGE}\`: the bridge removed it (or did not answer in time) but CT Studio could not; removing again finishes it.`,
          ),
          502: error(`\`${BRIDGE_DOWN}\`; nothing is removed.`),
        },
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      if (id === DEFAULT_TARGET_ID) {
        return reply.code(409).send({ error: 'default cannot be removed' });
      }
      const target = await repo.get(id);
      if (!target) return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
      if (target.kind === 'rdf') {
        return reply.code(409).send({ error: `${target.label} comes from RDF_ENDPOINT` });
      }
      const usage = await repo.usage(id);
      if (targetInUse(usage)) {
        return reply.code(409).send({ error: `${target.label} is used by ${usageText(usage)}` });
      }
      // The bridge first, while the row is held: it soft-removes the target and never takes its
      // id again, so it cannot be given back if a recipe or output started naming it meanwhile.
      // Once the bridge may have removed it (it accepted, or did not answer in time), a failure
      // says so: the bridge's DELETE is idempotent, so removing again heals it.
      let bridgeFailure: 'down' | 'maybe_removed' | null = null;
      let bridgeAccepted = false;
      const outcome = await repo
        .remove(id, async () => {
          try {
            bridgeAccepted = (await bridge.deleteTarget(id)) === 'deleted';
            return bridgeAccepted;
          } catch (err) {
            bridgeFailure =
              err instanceof BridgeApiError && err.timedOut ? 'maybe_removed' : 'down';
            throw err;
          }
        })
        .catch((err: unknown) => {
          if (bridgeFailure === 'down') return 'bridge_down' as const;
          if (bridgeFailure === 'maybe_removed' || bridgeAccepted) {
            req.log.error(
              { target: id, err },
              `publishing target ${id} may be removed on the bridge but not here: remove it again`,
            );
            return 'bridge_removed' as const;
          }
          throw err;
        });
      if (outcome === 'bridge_down') return reply.code(502).send({ error: BRIDGE_DOWN });
      if (outcome === 'bridge_removed') {
        return reply.code(500).send({ error: REMOVED_ON_BRIDGE });
      }
      if (outcome === 'refused') {
        return reply.code(409).send({ error: `${target.label} has deliveries on the bridge` });
      }
      if (outcome === 'missing') return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
      if (outcome === 'in_use') {
        return reply
          .code(409)
          .send({ error: `${target.label} is used by ${usageText(await repo.usage(id))}` });
      }
      req.log.info({ target: id }, 'publishing target removed');
      return reply.code(204).send();
    },
  );

  app.post(
    '/publish-targets/test',
    {
      schema: {
        ...base(
          'testPublishTarget',
          'Test a publishing target',
          md`
            **Admins only.** Through the delivery bridge: for an external target, checks the
            bucket exists (a missing one fails at \`connect\`), then writes a small file under the
            target's prefix with its connection, reads it back and deletes it. With an \`id\`
            alone, the saved target; otherwise settings not saved yet (a create body, the label
            optional). An internal target on CT Studio's own inbox, outputs, runs or backups
            bucket is refused (400). Always 200 for a test that ran: \`ok: false\` names the step
            that failed in plain words, and a bridge that cannot be reached fails at
            \`connect\`.
          `,
        ),
        body: TargetTestBodySchema,
        response: {
          200: res('The outcome.', TargetTestResultSchema),
          400: error(`Zod issues of the body, or ${OWN_BUCKET}.`),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const body = TargetTestBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: issuesOf(body.error) });
      const down = { ok: false, step: 'connect' as const, message: BRIDGE_DOWN };
      if ('id' in body.data) {
        const stored = await repo.get(body.data.id);
        if (!stored) return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
        return bridge.testTarget(stored.id).catch(() => down);
      }
      const settings = settingsFrom({ label: 'test', ...body.data }, null);
      const own = ownBucketProblem(settings, app.deps);
      if (own) return reply.code(400).send({ error: own });
      return bridge
        .testSettings({
          connectionId:
            settings.kind === 'internal' ? INTERNAL_CONNECTION_ID : settings.connectionId!,
          destination: s3Destination(settings),
        })
        .catch(() => down);
    },
  );
}
