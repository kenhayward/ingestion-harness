import { SinkViewSchema, TargetViewSchema, type SinkView } from '@ih/bridge-contract';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

/** What is shown for a sink that cannot describe itself right now. */
const unavailable = (id: string): SinkView => ({
  id,
  name: id,
  status: 'unavailable',
  contractVersion: 0,
  connectionKind: 'shared',
  capabilities: {
    browse: false,
    replace: false,
    withdraw: false,
    readBack: false,
    accepts: ['files'],
  },
});

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/sinks',
    {
      schema: {
        summary: 'List sinks',
        tags: ['Catalog'],
        response: { 200: z.strictObject({ sinks: z.array(SinkViewSchema) }) },
      },
    },
    async () => {
      const { sinks } = app.deps;
      const views = await Promise.all(
        sinks.ids().map(async (id): Promise<SinkView> => {
          try {
            const d = await sinks.get(id)!.describe();
            return {
              id,
              name: d.name,
              status: 'available',
              contractVersion: d.contractVersion,
              connectionKind: d.connectionKind,
              capabilities: d.capabilities,
            };
          } catch {
            return unavailable(id);
          }
        }),
      );
      return { sinks: views };
    },
  );

  app.get(
    '/v1/targets',
    {
      schema: {
        summary: 'List targets',
        tags: ['Catalog'],
        response: { 200: z.strictObject({ targets: z.array(TargetViewSchema) }) },
      },
    },
    async () => ({ targets: await app.deps.targets.list() }),
  );
};
