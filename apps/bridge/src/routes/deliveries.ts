import { randomUUID } from 'node:crypto';
import {
  bridgeError,
  BridgeErrorSchema,
  CreateDeliveriesRequestSchema,
  CreateDeliveriesResultSchema,
  DeliveryViewSchema,
  PreflightRequestSchema,
  PreflightResultSchema,
  type DeliveryView,
} from '@ih/bridge-contract';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { acceptDeliveries, readyTarget } from '../deliveries/accept.js';
import type { DeliveryRow } from '../deliveries/repo.js';
import { SinkError } from '../sinks/port.js';

const view = (row: DeliveryRow): DeliveryView => ({
  id: row.id,
  packageId: row.packageId,
  targetId: row.targetId,
  status: row.status,
  attempts: row.attempts,
  error: row.error,
  receipt: row.receipt,
  skippedFor: row.skippedFor,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** A contract error as its HTTP answer: 422 for a person to act on, 503 to try again. */
export function sendSinkError(reply: FastifyReply, err: SinkError): FastifyReply {
  return reply.code(err.error.class === 'needs_user' ? 422 : 503).send(err.error);
}

export const deliveryRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/deliveries::preflight',
    {
      schema: {
        summary: 'Check targets before a delivery',
        description:
          'Whether each target would take a delivery as the acting user now: it exists, its sink is available, and a personal sink has the user’s connection. Nothing is written.',
        tags: ['Deliveries'],
        body: PreflightRequestSchema,
        response: { 200: PreflightResultSchema, 400: BridgeErrorSchema },
      },
    },
    async (req, reply) => {
      const parsed = PreflightRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(bridgeError('content_rejected', 'the request is not valid'));
      }
      const { connections, sinks, targets } = app.deps;
      const results = [];
      for (const targetId of parsed.data.targets) {
        try {
          await readyTarget({ connections, sinks, targets }, targetId, parsed.data.actingUser);
          results.push({ targetId, problem: null });
        } catch (err) {
          if (!(err instanceof SinkError)) throw err;
          results.push({ targetId, problem: err.error });
        }
      }
      return { targets: results };
    },
  );

  app.post(
    '/v1/deliveries',
    {
      schema: {
        summary: 'Deliver a package',
        description:
          'Accepts one package for one or more targets, all or nothing, and queues one delivery per target.',
        tags: ['Deliveries'],
        body: CreateDeliveriesRequestSchema,
        response: {
          202: CreateDeliveriesResultSchema,
          400: BridgeErrorSchema,
          422: BridgeErrorSchema,
          503: BridgeErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const parsed = CreateDeliveriesRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(
          bridgeError('content_rejected', 'the delivery request is not valid', {
            issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          }),
        );
      }
      try {
        const { deliveries, packages, targets, sinks, connections, config } = app.deps;
        const result = await acceptDeliveries(
          {
            deliveries,
            packages,
            targets,
            sinks,
            connections,
            retentionDays: config.BRIDGE_PACKAGE_RETENTION_DAYS,
          },
          parsed.data,
          new Date(),
          randomUUID,
        );
        return reply.code(202).send(result);
      } catch (err) {
        if (err instanceof SinkError) return sendSinkError(reply, err);
        throw err;
      }
    },
  );

  app.get(
    '/v1/deliveries/:id',
    {
      schema: {
        summary: 'Read a delivery',
        tags: ['Deliveries'],
        params: z.strictObject({ id: z.string() }),
        response: { 200: DeliveryViewSchema, 404: BridgeErrorSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = z.string().uuid().safeParse(id).success
        ? await app.deps.deliveries.get(id)
        : null;
      if (!row) {
        return reply.code(404).send(bridgeError('not_found', `no delivery ${id}`));
      }
      return view(row);
    },
  );
};
