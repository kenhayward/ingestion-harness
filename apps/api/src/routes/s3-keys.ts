import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TargetChoiceSchema } from '@ih/shared';
import { z } from 'zod';
import { error, md, noContent, res } from '../openapi/zod.js';
import { IssuedKeySchema } from '../s3keys/service.js';
import { S3ConsumerSchema } from '../s3keys/repo.js';

const UUID = z.string().uuid();
const Expiry = z.union([
  z.literal(1),
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.literal(365),
  z.null(),
]);
const Targets = z
  .array(z.string().min(1))
  .min(1)
  .describe('Internal publishing target ids the keys may read (at least one).');
const CreateBody = z.object({
  label: z.string().trim().min(1).max(100),
  expiresInDays: Expiry,
  targets: Targets,
});
const TargetsBody = z.object({ targets: Targets });
const RotateBody = z.object({
  expiresInDays: Expiry,
  graceDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
});

/** Route docs (docs/design/api-docs.md). */
const ADR =
  'https://github.com/kenhayward/ingestion-harness/blob/main/docs/adr/0008-s3-read-keys.md';
const Settings = {
  endpoint: z.string().nullable().describe('The S3 endpoint the data lake uses, if configured.'),
};
const IssuedView = IssuedKeySchema.extend(Settings);
const BAD_TARGETS = error(
  '`grant at least one publishing target` or `<id> is not an internal publishing target`.',
);
const ADMINS_ONLY = error('`admins only`.');
const NOT_HERE = error(
  '`S3 keys are not available: the publish target is not the local SeaweedFS (ADR 0008)`, or ' +
    '`not found`.',
);
const UNREACHABLE = error('`SeaweedFS could not be reached: …`.');
const base = (operationId: string, summary: string, description: string) => ({
  tags: ['Data-lake S3 keys'],
  'x-admin': true,
  operationId,
  summary,
  description,
});
const ConsumerParams = z.object({ id: z.string().uuid().describe('The consumer id.') });

const NOT_AVAILABLE =
  'S3 keys are not available: the publish target is not the local SeaweedFS (ADR 0008)';
const unreachable = (err: unknown) =>
  `SeaweedFS could not be reached: ${err instanceof Error ? err.message : String(err)}`;

/**
 * Read-only S3 keys for the data lake (ADR 0008), under Administration > Access. Admins only; the access
 * hook has already required a session (and `deps.access === null` disables both in unit tests).
 */
export async function s3KeyRoutes(app: FastifyInstance): Promise<void> {
  const service = app.deps.s3Keys;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
    if (!service) return reply.code(404).send({ error: NOT_AVAILABLE });
  });

  const validId = (id: string, reply: FastifyReply) =>
    UUID.safeParse(id).success || (reply.code(404).send({ error: 'not found' }), false);

  app.get(
    '/access/s3-keys',
    {
      schema: {
        ...base(
          'listS3Keys',
          'List data-lake consumers and keys',
          md`
            **Admins only.** The data-lake consumers (one read-only SeaweedFS identity
            each, \`lake-{id}\`) and their keys, never their secrets, with the bucket and
            endpoint the data lake is configured with. \`internalTargets\` are the internal
            publishing targets a key can be granted on (none when there is no internal
            target); each consumer lists its granted ids in \`targets\`. See
            [ADR 0008](${ADR}).`,
        ),
        response: {
          200: res(
            'The consumers.',
            z.object({
              ...Settings,
              internalTargets: z.array(TargetChoiceSchema),
              consumers: z.array(S3ConsumerSchema),
            }),
          ),
          403: ADMINS_ONLY,
          404: NOT_HERE,
        },
      },
    },
    async () => service!.list(),
  );

  app.post(
    '/access/s3-keys',
    {
      schema: {
        ...base(
          'createS3Key',
          'Create a data-lake consumer and key',
          md`
            **Admins only.** Creates a consumer with read-only access to the buckets and
            prefixes of the given internal publishing \`targets\` and its first key. The \`secretAccessKey\` is in this response only:
            SeaweedFS holds it and it is never shown again.
          `,
        ),
        body: CreateBody,
        response: {
          200: res('The consumer, key and secret.', IssuedView),
          400: error(
            '`label (1-100 chars) and expiresInDays are required`, `grant at least one ' +
              'publishing target` or `<id> is not an internal publishing target`.',
          ),
          403: ADMINS_ONLY,
          404: NOT_HERE,
          409: error('`add an internal publishing target first`.'),
          502: UNREACHABLE,
        },
      },
    },
    async (req, reply) => {
      if ((await service!.internalTargets()).length === 0) {
        return reply.code(409).send({ error: 'add an internal publishing target first' });
      }
      const body = CreateBody.safeParse(req.body ?? {});
      if (!body.success) {
        const noTargets = body.error.issues.some((i) => i.path[0] === 'targets');
        return reply.code(400).send({
          error: noTargets
            ? 'grant at least one publishing target'
            : 'label (1-100 chars) and expiresInDays are required',
        });
      }
      try {
        const issued = await service!.issue(
          body.data.label,
          body.data.expiresInDays,
          body.data.targets,
        );
        if ('problem' in issued) return reply.code(issued.status).send({ error: issued.problem });
        return { ...issued, ...service!.settings };
      } catch (err) {
        req.log.error({ err }, 'issuing an S3 key failed');
        return reply.code(502).send({ error: unreachable(err) });
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    '/access/s3-keys/:id/targets',
    {
      schema: {
        ...base(
          'setS3KeyTargets',
          'Change the targets a consumer may read',
          md`
            **Admins only.** Replaces the internal publishing targets the consumer's keys can
            read; its SeaweedFS policy is rewritten at once (and again by the reconciler if
            it is ever changed behind our back).
          `,
        ),
        params: ConsumerParams,
        body: TargetsBody,
        response: {
          200: res('The consumer.', S3ConsumerSchema),
          400: BAD_TARGETS,
          403: ADMINS_ONLY,
          404: NOT_HERE,
          502: UNREACHABLE,
        },
      },
    },
    async (req, reply) => {
      if (!validId(req.params.id, reply)) return reply;
      const body = TargetsBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'grant at least one publishing target' });
      }
      try {
        const result = await service!.setTargets(req.params.id, body.data.targets);
        if (result === 'not_found') return reply.code(404).send({ error: 'not found' });
        if (result !== 'ok') return reply.code(result.status).send({ error: result.problem });
        return (await service!.list()).consumers.find((c) => c.id === req.params.id);
      } catch (err) {
        req.log.error({ err }, 'changing the targets of an S3 key consumer failed');
        return reply.code(502).send({ error: unreachable(err) });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/access/s3-keys/:id/rotate',
    {
      schema: {
        ...base(
          'rotateS3Key',
          "Rotate a consumer's key",
          md`
            **Admins only.** Issues a new key for the consumer and sets the current
            ones to expire after \`graceDays\` (1, 7 or 30), so the data lake can switch without
            downtime. A consumer has at most two active keys.
          `,
        ),
        params: ConsumerParams,
        body: RotateBody,
        response: {
          200: res('The new key and secret.', IssuedView),
          400: error('`expiresInDays and graceDays (1, 7 or 30) are required`.'),
          403: ADMINS_ONLY,
          404: NOT_HERE,
          409: error('`this consumer already has two active keys: revoke one first`.'),
          502: UNREACHABLE,
        },
      },
    },
    async (req, reply) => {
      if (!validId(req.params.id, reply)) return reply;
      const body = RotateBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: 'expiresInDays and graceDays (1, 7 or 30) are required' });
      }
      try {
        const result = await service!.rotate(
          req.params.id,
          body.data.expiresInDays,
          body.data.graceDays,
        );
        if (result === 'not_found') return reply.code(404).send({ error: 'not found' });
        if (result === 'limit') {
          return reply
            .code(409)
            .send({ error: 'this consumer already has two active keys: revoke one first' });
        }
        return { ...result, ...service!.settings };
      } catch (err) {
        req.log.error({ err }, 'rotating an S3 key failed');
        return reply.code(502).send({ error: unreachable(err) });
      }
    },
  );

  app.post<{ Params: { keyId: string } }>(
    '/access/s3-keys/keys/:keyId/revoke',
    {
      schema: {
        ...base(
          'revokeS3Key',
          'Revoke a key',
          md`
            **Admins only.** Revokes one key and deletes it from SeaweedFS at once. If
            SeaweedFS is unreachable, the key is still revoked and is deleted as soon as it can
            be reached (the reconciler runs every minute).
          `,
        ),
        params: z.object({ keyId: z.string().uuid().describe('The key id.') }),
        response: {
          204: noContent('Revoked and deleted.'),
          403: ADMINS_ONLY,
          404: NOT_HERE,
          502: error(
            '`Revoked, but SeaweedFS could not be reached: …. The key is deleted as soon as it ' +
              'is reachable.`',
          ),
        },
      },
    },
    async (req, reply) => {
      if (!validId(req.params.keyId, reply)) return reply;
      try {
        const result = await service!.revoke(req.params.keyId);
        if (result === 'not_found') return reply.code(404).send({ error: 'not found' });
        return reply.code(204).send();
      } catch (err) {
        req.log.error({ err }, 'deleting a revoked S3 key failed; reconcile will retry');
        return reply.code(502).send({
          error: `Revoked, but ${unreachable(err)}. The key is deleted as soon as it is reachable.`,
        });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/access/s3-keys/:id',
    {
      schema: {
        ...base(
          'deleteS3Consumer',
          'Delete a data-lake consumer',
          md`
            **Admins only.** Deletes the consumer, its keys and its SeaweedFS
            identity: its keys stop working at once.
          `,
        ),
        params: ConsumerParams,
        response: {
          204: noContent('Deleted.'),
          403: ADMINS_ONLY,
          404: NOT_HERE,
          502: UNREACHABLE,
        },
      },
    },
    async (req, reply) => {
      if (!validId(req.params.id, reply)) return reply;
      try {
        const result = await service!.remove(req.params.id);
        if (result === 'not_found') return reply.code(404).send({ error: 'not found' });
        return reply.code(204).send();
      } catch (err) {
        req.log.error({ err }, 'deleting an S3 key consumer failed');
        return reply.code(502).send({ error: unreachable(err) });
      }
    },
  );
}
