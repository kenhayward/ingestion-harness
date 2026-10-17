import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_TARGET_ID,
  normalisePrefix,
  publishTargetIdFrom,
  PublishTargetViewSchema,
  TargetChoiceSchema,
  TargetCreateBodySchema,
  TargetPatchBodySchema,
  TargetTestBodySchema,
  TargetTestResultSchema,
  targetInUse,
  type TargetUsage,
} from '@ih/shared';
import { z } from 'zod';
import { encryptSecret } from '../llm/secrets.js';
import { error, md, noContent, res } from '../openapi/zod.js';
import { probeTarget } from '../publish-targets/probe.js';
import type { NewTarget, TargetPatch, TargetRecord } from '../publish-targets/repo.js';
import { TargetUnavailableError } from '../publish-targets/stores.js';

const ADMINS_ONLY = error('`admins only`.');
const NOT_FOUND_MESSAGE = 'publishing target not found';
const NOT_FOUND = error(`\`${NOT_FOUND_MESSAGE}\`.`);
const NO_SECRETS = 'LLM_SECRETS_KEY is not set: the API cannot store keys';
const PAIR = 'set the access key and the secret together';
const IdParams = z.object({ id: z.string().describe('The publishing target id.') });
const LOCKED = ['bucket', 'prefix', 'endpoint', 'region'] as const;
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

const OWN_BUCKET = "`{bucket} is CT Studio's own {inbox|outputs|runs} bucket: pick another`";

/** Which of the deployment's own buckets an internal target would name, else null. */
function ownBucketProblem(
  target: { kind: string; bucket: string },
  buckets: { inbox: string; outputs: string; runs: string },
): string | null {
  if (target.kind !== 'internal') return null;
  const which = (['inbox', 'outputs', 'runs'] as const).find((k) => buckets[k] === target.bucket);
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

/**
 * Stands in for a credential that is stored (or read from `.env`) while merged settings are
 * checked with the create rules; only its presence matters, and it never reaches a record.
 */
const PRESENT = 'stored-credential';

/**
 * The stored settings in create-body shape (secrets as placeholders: only presence matters), so
 * an overlay can be checked with the create rules.
 */
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
    ...(t.endpoint ? { endpoint: t.endpoint } : {}),
    ...(t.region ? { region: t.region } : {}),
    ...(t.accessKeyId || t.accessKeyEnv ? { accessKeyId: PRESENT } : {}),
    ...(t.secretKeyEnc || t.secretKeyEnv ? { secretAccessKey: PRESENT } : {}),
    forcePathStyle: t.forcePathStyle,
    sse: t.sse,
    ...(t.kmsKeyId ? { kmsKeyId: t.kmsKeyId } : {}),
    ...(t.storageClass ? { storageClass: t.storageClass } : {}),
  };
}

/**
 * Settings checked with the create rules into a record (no secret: it is passed apart).
 * `sentKeyId` is the access key id the request itself gave; without one the stored id (or the
 * `.env` name it is read from) is kept.
 */
function recordOf(
  id: string,
  b: z.infer<typeof TargetCreateBodySchema>,
  stored: TargetRecord | null,
  sentKeyId: string | undefined,
): TargetRecord {
  const external = b.kind === 'external';
  return {
    id,
    label: b.label,
    kind: b.kind,
    bucket: b.bucket,
    // A stored prefix kept as it is (`default` is seeded verbatim from `.env`); a new one normalised.
    prefix: stored && b.prefix === stored.prefix ? stored.prefix : normalisePrefix(b.prefix),
    endpoint: external ? (b.endpoint ?? null) : null,
    region: external ? (b.region ?? null) : null,
    accessKeyId: external ? (sentKeyId ?? stored?.accessKeyId ?? null) : null,
    secretKeyEnc: stored?.secretKeyEnc ?? null,
    accessKeyEnv: external && sentKeyId === undefined ? (stored?.accessKeyEnv ?? null) : null,
    secretKeyEnv: stored?.secretKeyEnv ?? null,
    forcePathStyle: external ? b.forcePathStyle : false,
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

/**
 * Publishing targets (Administration > Published outputs): where recipes deliver. Admins only,
 * except the picker's choices (any designer or admin; the access hook refuses operators). The
 * access hook has already required a session (`deps.access === null` disables both in unit
 * tests). Secrets are encrypted here, never returned, logged or echoed.
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

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  });

  const by = (req: FastifyRequest) => req.auth?.label ?? null;
  const encrypt = (secret: string) =>
    app.deps.llmSecrets ? encryptSecret(secret, app.deps.llmSecrets) : null;
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
            A secret is never returned, only \`secretSet\`.
          `,
        ),
        response: {
          200: res('The targets.', z.object({ targets: z.array(PublishTargetViewSchema) })),
          403: ADMINS_ONLY,
        },
      },
    },
    async () => ({ targets: await repo.list() }),
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
            bucket is created here when missing) or an external S3 bucket. The id is made from
            the label when not given (\`-2\`, \`-3\`… when taken); \`default\` is reserved. Use the
            same id on every deployment for the same recipient: recipes carry it. A secret is
            stored encrypted with \`LLM_SECRETS_KEY\` (409 without it).
          `,
        ),
        body: TargetCreateBodySchema,
        response: {
          201: res('The target.', PublishTargetViewSchema),
          400: error(`Zod issues, \`default is reserved\`, or ${OWN_BUCKET}.`),
          403: ADMINS_ONLY,
          409: error(`\`a publishing target {id} already exists\`, or \`${NO_SECRETS}\`.`),
          502: error('`could not create bucket {bucket}: {message}`; nothing is stored.'),
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
      const secretKeyEnc = b.secretAccessKey === undefined ? null : encrypt(b.secretAccessKey);
      if (b.secretAccessKey !== undefined && secretKeyEnc === null) {
        return reply.code(409).send({ error: NO_SECRETS });
      }
      const record = { ...recordOf(id, b, null, b.accessKeyId), secretKeyEnc };
      const own = ownBucketProblem(record, app.deps.buckets);
      if (own) return reply.code(400).send({ error: own });
      const problem = await bucketProblem(record);
      if (problem) return reply.code(502).send({ error: problem });
      const input: NewTarget = {
        id,
        label: record.label,
        kind: record.kind,
        bucket: record.bucket,
        prefix: record.prefix,
        endpoint: record.endpoint,
        region: record.region,
        accessKeyId: record.accessKeyId,
        secretKeyEnc,
        accessKeyEnv: null,
        secretKeyEnv: null,
        forcePathStyle: record.forcePathStyle,
        sse: record.sse,
        kmsKeyId: record.kmsKeyId,
        storageClass: record.storageClass,
      };
      const created = await repo.create(input, by(req));
      if (created === 'exists') {
        return reply.code(409).send({ error: `a publishing target ${id} already exists` });
      }
      stores.invalidate();
      req.log.info({ target: id, kind: input.kind }, 'publishing target added');
      return reply.code(201).send(created);
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
            **Admins only.** Fields left out are kept; \`null\` clears the endpoint, KMS key or
            storage class, and the KMS key is cleared whenever the encryption is not
            \`aws:kms\`. An internal target cannot move onto CT Studio's own inbox, outputs or
            runs bucket (400). While the target is in use (a published recipe version names it,
            an output or graph copy was delivered to it, an S3 key consumer is granted it, or a
            withdrawal still to run names it) its bucket, prefix, endpoint and region cannot
            change (409):
            add a new target and publish a version naming it instead. The label, credentials,
            path style, encryption and storage class may always change, so a key is rotated
            without a new version. Keys read from \`.env\` are replaced only as a pair.
          `,
        ),
        params: IdParams,
        body: TargetPatchBodySchema,
        response: {
          200: res('The target.', PublishTargetViewSchema),
          400: error(`Zod issues, \`${PAIR}\`, or ${OWN_BUCKET}.`),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error(
            `\`{label} is used by {what}: add a new target instead\`, or \`${NO_SECRETS}\`.`,
          ),
          502: error('`could not create bucket {bucket}: {message}`; nothing is changed.'),
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
      const next = recordOf(stored.id, merged.data, stored, patch.accessKeyId);
      if (patch.bucket !== undefined) {
        const own = ownBucketProblem(next, app.deps.buckets);
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
      const fromEnv = stored.accessKeyEnv !== null || stored.secretKeyEnv !== null;
      if (fromEnv && (patch.accessKeyId === undefined) !== (patch.secretAccessKey === undefined)) {
        return reply.code(400).send({ error: PAIR });
      }
      let secretKeyEnc: string | undefined;
      if (patch.secretAccessKey !== undefined) {
        const enc = encrypt(patch.secretAccessKey);
        if (enc === null) return reply.code(409).send({ error: NO_SECRETS });
        secretKeyEnc = enc;
      }
      if (next.bucket !== stored.bucket) {
        const problem = await bucketProblem(next);
        if (problem) return reply.code(502).send({ error: problem });
      }

      const update: TargetPatch = {};
      if (patch.label !== undefined) update.label = next.label;
      if (patch.bucket !== undefined) update.bucket = next.bucket;
      if (patch.prefix !== undefined) update.prefix = next.prefix;
      if (patch.endpoint !== undefined) update.endpoint = next.endpoint;
      if (patch.region !== undefined) update.region = next.region;
      if (patch.accessKeyId !== undefined) update.accessKeyId = next.accessKeyId;
      if (secretKeyEnc !== undefined) update.secretKeyEnc = secretKeyEnc;
      if (patch.forcePathStyle !== undefined) update.forcePathStyle = next.forcePathStyle;
      if (patch.sse !== undefined) update.sse = next.sse;
      if (patch.kmsKeyId !== undefined || next.kmsKeyId !== stored.kmsKeyId) {
        update.kmsKeyId = next.kmsKeyId;
      }
      if (patch.storageClass !== undefined) update.storageClass = next.storageClass;
      const updated = await repo.update(stored.id, update, by(req));
      if (!updated) return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
      stores.invalidate();
      req.log.info(
        { target: stored.id, fields: Object.keys(update).filter((k) => k !== 'secretKeyEnc') },
        'publishing target changed',
      );
      return updated;
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
            to run names it. The \`default\`
            target is never removed.
          `,
        ),
        params: IdParams,
        response: {
          204: noContent('Removed.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('`default cannot be removed`, or `{label} is used by {what}`.'),
        },
      },
    },
    async (req, reply) => {
      const target = await repo.get(req.params.id);
      if (req.params.id !== DEFAULT_TARGET_ID && !target) {
        return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
      }
      const outcome = await repo.remove(req.params.id);
      if (outcome === 'default') {
        return reply.code(409).send({ error: 'default cannot be removed' });
      }
      if (outcome === 'missing') return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
      if (outcome === 'in_use') {
        const usage = await repo.usage(req.params.id);
        return reply.code(409).send({ error: `${target!.label} is used by ${usageText(usage)}` });
      }
      stores.invalidate();
      req.log.info({ target: req.params.id }, 'publishing target removed');
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
            **Admins only.** For an external target, checks the bucket exists (a missing one
            fails at \`connect\`: some servers would create it on the first write), then writes
            a small file under the target's prefix, reads it back and deletes it. With an \`id\`,
            the stored target's settings overlaid with the body as a save would overlay them
            (\`null\` clears, its stored secret when the body has none); without one, a full set
            of new settings (before saving). An internal target on CT Studio's own inbox, outputs
            or runs bucket is refused (400). Always 200 for a test that ran: \`ok: false\` names
            the step that failed in plain words. A secret sent here is never stored, logged or
            echoed.
          `,
        ),
        body: TargetTestBodySchema,
        response: {
          200: res('The outcome.', TargetTestResultSchema),
          400: error(`Zod issues of the body or of the merged settings, or ${OWN_BUCKET}.`),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const body = TargetTestBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: issuesOf(body.error) });
      const { id, ...given } = body.data;
      const stored = id === undefined ? null : await repo.get(id);
      if (id !== undefined && !stored) return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
      const merged = TargetCreateBodySchema.safeParse(stored ? overlay(stored, given) : given);
      if (!merged.success) return reply.code(400).send({ error: issuesOf(merged.error) });
      const settings = recordOf(stored?.id ?? 'test', merged.data, stored, given.accessKeyId);
      const own = ownBucketProblem(settings, app.deps.buckets);
      if (own) return reply.code(400).send({ error: own });
      let store;
      try {
        store = stores.storeOf(settings, given.secretAccessKey);
      } catch (err) {
        if (!(err instanceof TargetUnavailableError)) throw err;
        return { ok: false, step: 'connect', message: err.message };
      }
      return probeTarget(store, settings.bucket, settings.prefix, {
        checkBucket: settings.kind === 'external',
      });
    },
  );
}
