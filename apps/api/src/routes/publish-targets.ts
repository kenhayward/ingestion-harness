import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_TARGET_ID,
  normalisePrefix,
  publishTargetIdFrom,
  PublishTargetViewSchema,
  TargetChoiceSchema,
  TargetConnectionSchema,
  TargetCreateBodySchema,
  TargetPatchBodySchema,
  TargetTestBodySchema,
  TargetTestResultSchema,
  targetInUse,
  type PublishTargetView,
  type TargetConnection,
  type TargetUsage,
} from '@ih/shared';
import { z } from 'zod';
import { BridgeApiError } from '../bridge/client.js';
import { destinationOf, INTERNAL_CONNECTION_ID, mirrorOf } from '../bridge/mirror.js';
import { error, md, noContent, res } from '../openapi/zod.js';
import type { NewTarget, TargetPatch, TargetRecord } from '../publish-targets/repo.js';

const ADMINS_ONLY = error('`admins only`.');
const NOT_FOUND_MESSAGE = 'publishing target not found';
const NOT_FOUND = error(`\`${NOT_FOUND_MESSAGE}\`.`);
const BRIDGE_DOWN = 'the delivery bridge could not be reached';
const IdParams = z.object({ id: z.string().describe('The publishing target id.') });
const LOCKED = ['bucket', 'prefix'] as const;
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

/**
 * The stored settings overlaid with a patch, in create-body shape: `null` clears a field, and
 * the KMS key goes whenever the resulting encryption is not KMS (unless the patch names one,
 * which the create rules then refuse).
 */
function overlay(stored: TargetRecord, patch: Record<string, unknown>): Record<string, unknown> {
  const shape: Record<string, unknown> = { ...createShape(stored) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete shape[k];
    else if (v !== undefined) shape[k] = v;
  }
  if (shape.sse !== 'aws:kms' && patch.kmsKeyId === undefined) delete shape.kmsKeyId;
  return shape;
}

/** The stored settings in create-body shape, so an overlay can be checked with the create rules. */
function createShape(t: TargetRecord): Record<string, unknown> {
  const shape: Record<string, unknown> = {
    label: t.label,
    kind: t.kind,
    bucket: t.bucket,
    prefix: t.prefix,
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

/** Settings checked with the create rules into a record. */
function recordOf(
  id: string,
  b: z.infer<typeof TargetCreateBodySchema>,
  stored: TargetRecord | null,
): TargetRecord {
  const external = b.kind === 'external';
  return {
    id,
    label: b.label,
    kind: b.kind,
    bucket: b.bucket,
    // A stored prefix kept as it is (`default` is seeded verbatim from `.env`); a new one normalised.
    prefix: stored && b.prefix === stored.prefix ? stored.prefix : normalisePrefix(b.prefix),
    // What a target held before its keys moved to the bridge is left as it was.
    endpoint: stored?.endpoint ?? null,
    region: stored?.region ?? null,
    accessKeyId: stored?.accessKeyId ?? null,
    secretKeyEnc: stored?.secretKeyEnc ?? null,
    accessKeyEnv: stored?.accessKeyEnv ?? null,
    secretKeyEnv: stored?.secretKeyEnv ?? null,
    forcePathStyle: stored?.forcePathStyle ?? false,
    connectionId: external ? (b.connectionId ?? null) : null,
    movedToBridgeAt: stored?.movedToBridgeAt ?? null,
    sse: external ? b.sse : 'none',
    kmsKeyId: external ? (b.kmsKeyId ?? null) : null,
    storageClass: external ? (b.storageClass ?? null) : null,
    source: stored?.source ?? 'ui',
    seededAt: stored?.seededAt ?? null,
    editedAt: stored?.editedAt ?? null,
    updatedBy: stored?.updatedBy ?? null,
    createdAt: stored?.createdAt ?? new Date().toISOString(),
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
 * is mirrored to the bridge.
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
    async () => ({ choices: await app.deps.targets.choices() }),
  );

  await app.register(adminRoutes);
}

async function adminRoutes(app: FastifyInstance): Promise<void> {
  const repo = app.deps.targets;
  const stores = app.deps.targetStores;
  const bridge = app.deps.bridge;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  });

  const by = (req: FastifyRequest) => req.auth?.label ?? null;
  /** Creates an internal target's bucket; the error message, else null. */
  const bucketProblem = async (target: TargetRecord): Promise<string | null> => {
    if (target.kind !== 'internal') return null;
    try {
      await stores.ensureBucket(target);
      return null;
    } catch (err) {
      return `could not create bucket ${target.bucket}: ${(err as Error).message}`;
    }
  };
  /** The bridge's shared S3 connections by id; empty when it cannot be reached. */
  const connections = async (): Promise<Map<string, TargetConnection>> => {
    try {
      const listed = await bridge.listConnections('shared');
      return new Map(
        listed
          .filter((c) => c.sinkId === 's3')
          .map((c) => [
            c.id,
            { id: c.id, name: c.name, status: c.status, statusReason: c.statusReason },
          ]),
      );
    } catch (err) {
      app.log.warn({ err }, 'the bridge could not list its connections');
      return new Map();
    }
  };
  const withConnections = async (views: PublishTargetView[]): Promise<PublishTargetView[]> => {
    if (!views.some((v) => v.connectionId)) return views;
    const known = await connections();
    return views.map((v) => ({
      ...v,
      connection: v.connectionId ? (known.get(v.connectionId) ?? null) : null,
    }));
  };

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
            mirrored to the bridge; when the bridge refuses it (422, its message) or cannot be
            reached (502), nothing is stored. No credential is accepted here.
          `,
        ),
        body: TargetCreateBodySchema,
        response: {
          201: res('The target.', PublishTargetViewSchema),
          400: error(`Zod issues, \`default is reserved\`, or ${OWN_BUCKET}.`),
          403: ADMINS_ONLY,
          409: error('`a publishing target {id} already exists`.'),
          422: error("The bridge's refusal, e.g. `there is no connection {id}`."),
          502: error(
            `\`could not create bucket {bucket}: {message}\`, or \`${BRIDGE_DOWN}\`; nothing is stored.`,
          ),
        },
      },
    },
    async (req, reply) => {
      const body = TargetCreateBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: issuesOf(body.error) });
      const b = body.data;
      if (b.id === DEFAULT_TARGET_ID) return reply.code(400).send({ error: 'default is reserved' });
      let id = b.id;
      if (id === undefined) {
        const taken = new Set((await repo.list()).map((t) => t.id));
        const stem = publishTargetIdFrom(b.label);
        id = stem;
        for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
      } else if (await repo.get(id)) {
        return reply.code(409).send({ error: `a publishing target ${id} already exists` });
      }
      const record = recordOf(id, b, null);
      const own = ownBucketProblem(record, app.deps);
      if (own) return reply.code(400).send({ error: own });
      const problem = await bucketProblem(record);
      if (problem) return reply.code(502).send({ error: problem });
      const input: NewTarget = {
        id,
        label: record.label,
        kind: record.kind,
        bucket: record.bucket,
        prefix: record.prefix,
        endpoint: null,
        region: null,
        accessKeyId: null,
        secretKeyEnc: null,
        accessKeyEnv: null,
        secretKeyEnv: null,
        forcePathStyle: false,
        sse: record.sse,
        kmsKeyId: record.kmsKeyId,
        storageClass: record.storageClass,
        connectionId: record.connectionId,
      };
      const created = await repo.create(input, by(req));
      if (created === 'exists') {
        return reply.code(409).send({ error: `a publishing target ${id} already exists` });
      }
      try {
        await bridge.putTarget(id, mirrorOf((await repo.get(id))!));
      } catch (err) {
        // One unit with the bridge: a target it refuses is not kept here either.
        await repo.remove(id);
        return bridgeFailure(reply, err);
      }
      req.log.info({ target: id, kind: input.kind }, 'publishing target added');
      return reply.code(201).send((await withConnections([created]))[0]);
    },
  );

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
            version. The change is mirrored to the bridge; when the bridge refuses it (422) or
            cannot be reached (502), the target is left as it was.
          `,
        ),
        params: IdParams,
        body: TargetPatchBodySchema,
        response: {
          200: res('The target.', PublishTargetViewSchema),
          400: error(`Zod issues, or ${OWN_BUCKET}.`),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('`{label} is used by {what}: add a new target instead`.'),
          422: error("The bridge's refusal, e.g. `there is no connection {id}`."),
          502: error(
            `\`could not create bucket {bucket}: {message}\`, or \`${BRIDGE_DOWN}\`; nothing is changed.`,
          ),
        },
      },
    },
    async (req, reply) => {
      const body = TargetPatchBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: issuesOf(body.error) });
      const patch = body.data;
      const stored = await repo.get(req.params.id);
      if (!stored) return reply.code(404).send({ error: NOT_FOUND_MESSAGE });

      const merged = TargetCreateBodySchema.safeParse(overlay(stored, patch));
      if (!merged.success) return reply.code(400).send({ error: issuesOf(merged.error) });
      const next = recordOf(stored.id, merged.data, stored);
      if (patch.bucket !== undefined) {
        const own = ownBucketProblem(next, app.deps);
        if (own) return reply.code(400).send({ error: own });
      }

      const changed = LOCKED.filter((k) => patch[k] !== undefined && next[k] !== stored[k]);
      if (changed.length > 0) {
        const usage = await repo.usage(stored.id);
        if (targetInUse(usage)) {
          return reply.code(409).send({
            error: `${stored.label} is used by ${usageText(usage)}: add a new target instead`,
          });
        }
      }
      if (next.bucket !== stored.bucket) {
        const problem = await bucketProblem(next);
        if (problem) return reply.code(502).send({ error: problem });
      }

      const update: TargetPatch = {};
      if (patch.label !== undefined) update.label = next.label;
      if (patch.bucket !== undefined) update.bucket = next.bucket;
      if (patch.prefix !== undefined) update.prefix = next.prefix;
      if (patch.connectionId !== undefined) update.connectionId = next.connectionId;
      if (patch.sse !== undefined) update.sse = next.sse;
      if (patch.kmsKeyId !== undefined || next.kmsKeyId !== stored.kmsKeyId) {
        update.kmsKeyId = next.kmsKeyId;
      }
      if (patch.storageClass !== undefined) update.storageClass = next.storageClass;
      const updated = await repo.update(stored.id, update, by(req));
      if (!updated) return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
      try {
        await bridge.putTarget(stored.id, mirrorOf((await repo.get(stored.id))!));
      } catch (err) {
        // One unit with the bridge: the row goes back to what it was.
        const previous: TargetPatch = {};
        for (const k of Object.keys(update) as (keyof TargetPatch)[]) {
          (previous as Record<string, unknown>)[k] = stored[k as keyof TargetRecord];
        }
        await repo.update(stored.id, previous, stored.updatedBy);
        return bridgeFailure(reply, err);
      }
      req.log.info({ target: stored.id, fields: Object.keys(update) }, 'publishing target changed');
      return (await withConnections([updated]))[0];
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
            bridge first: one the bridge still has deliveries for stays (409), and nothing is
            removed while the bridge cannot be reached (502).
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
      const usage = await repo.usage(id);
      if (targetInUse(usage)) {
        return reply.code(409).send({ error: `${target.label} is used by ${usageText(usage)}` });
      }
      try {
        if ((await bridge.deleteTarget(id)) === 'in_use') {
          return reply.code(409).send({ error: `${target.label} has deliveries on the bridge` });
        }
      } catch {
        return reply.code(502).send({ error: BRIDGE_DOWN });
      }
      const outcome = await repo.remove(id);
      if (outcome === 'missing') return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
      if (outcome === 'in_use') {
        // Used meanwhile: the bridge gets it back, so its deliveries still have a target.
        await bridge.putTarget(id, mirrorOf(target)).catch(() => undefined);
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
      const settings = recordOf('test', { label: 'test', ...body.data }, null);
      const own = ownBucketProblem(settings, app.deps);
      if (own) return reply.code(400).send({ error: own });
      return bridge
        .testSettings({
          connectionId:
            settings.kind === 'internal' ? INTERNAL_CONNECTION_ID : settings.connectionId!,
          destination: destinationOf(settings),
        })
        .catch(() => down);
    },
  );
}
