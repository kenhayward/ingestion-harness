import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const UUID = z.string().uuid();
const Expiry = z.union([
  z.literal(1),
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.literal(365),
  z.null(),
]);
const CreateBody = z.object({ label: z.string().trim().min(1).max(100), expiresInDays: Expiry });
const RotateBody = z.object({
  expiresInDays: Expiry,
  graceDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
});

const NOT_AVAILABLE =
  'S3 keys are not available: the publish target is not the local SeaweedFS (ADR 0008)';
const unreachable = (err: unknown) =>
  `SeaweedFS could not be reached: ${err instanceof Error ? err.message : String(err)}`;

/**
 * Read-only S3 keys for the data lake (ADR 0008), on the Access page. Admins only; the access
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

  app.get('/access/s3-keys', async () => service!.list());

  app.post('/access/s3-keys', async (req, reply) => {
    const body = CreateBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'label (1-100 chars) and expiresInDays are required' });
    }
    try {
      const issued = await service!.issue(body.data.label, body.data.expiresInDays);
      return { ...issued, ...service!.settings };
    } catch (err) {
      req.log.error({ err }, 'issuing an S3 key failed');
      return reply.code(502).send({ error: unreachable(err) });
    }
  });

  app.post<{ Params: { id: string } }>('/access/s3-keys/:id/rotate', async (req, reply) => {
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
  });

  app.post<{ Params: { keyId: string } }>(
    '/access/s3-keys/keys/:keyId/revoke',
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

  app.delete<{ Params: { id: string } }>('/access/s3-keys/:id', async (req, reply) => {
    if (!validId(req.params.id, reply)) return reply;
    try {
      const result = await service!.remove(req.params.id);
      if (result === 'not_found') return reply.code(404).send({ error: 'not found' });
      return reply.code(204).send();
    } catch (err) {
      req.log.error({ err }, 'deleting an S3 key consumer failed');
      return reply.code(502).send({ error: unreachable(err) });
    }
  });
}
