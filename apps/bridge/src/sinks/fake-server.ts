import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { FakeSink } from './fake.js';
import { serveSink } from './serve.js';

/** How many deliveries `/_delivered` keeps. */
const KEPT = 50;

/**
 * The fake external sink for compose smoke tests and CI (compose profile `fake-sink`): the
 * FakeSink behind the sink contract's signed routes, with a shared connection kind, a browsable
 * fixed field `space` and an overridable name pattern `name`. It replaces what an idempotency
 * key delivered before. `GET /_delivered` (unsigned, test stacks only) lists the last deliveries
 * without their bytes, and how many keys it holds.
 */
export async function buildFakeServer(key: string, logger = false): Promise<FastifyInstance> {
  const sink = new FakeSink({
    name: 'Fake sink',
    destinationFields: [
      {
        id: 'space',
        label: 'Space',
        kind: 'fixed',
        required: true,
        overridable: false,
        browse: true,
      },
      {
        id: 'name',
        label: 'Name',
        kind: 'pattern',
        required: true,
        overridable: true,
        browse: false,
      },
    ],
    capabilities: {
      browse: true,
      replace: true,
      withdraw: false,
      readBack: false,
      accepts: ['files', 'data'],
    },
  });
  const app = await serveSink(sink, key, { unsigned: ['/_delivered'], logger });
  app.get('/_delivered', async () => {
    const delivered = sink.delivered.slice(-KEPT).map((d) => ({
      idempotencyKey: d.idempotencyKey,
      destination: d.destination,
      actingUser: d.actingUser,
      files: d.package.files.map((f) => f.name),
    }));
    return {
      keys: new Set(sink.delivered.map((d) => d.idempotencyKey)).size,
      deliveries: delivered,
    };
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.FAKE_SINK_KEY ?? '';
  if (key.length < 32) {
    console.error('FAKE_SINK_KEY must be at least 32 characters');
    process.exit(2);
  }
  const app = await buildFakeServer(key, true);
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
}
