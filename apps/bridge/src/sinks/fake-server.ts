import { pathToFileURL } from 'node:url';
import { bridgeError, type BrowseRequest } from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';
import { FakeSink } from './fake.js';
import { SinkError } from './port.js';
import { serveSink } from './serve.js';

/** How many deliveries `/_delivered` keeps. */
const KEPT = 50;

/**
 * The fake external sink for compose smoke tests and CI (compose profile `fake-sink`): the
 * FakeSink behind the sink contract's signed routes, with a shared connection kind, a browsable
 * fixed field `space` and an overridable name pattern `name`. It replaces what an idempotency
 * key delivered before, and refuses a name starting `taken-` (`name_conflict`). `GET /_delivered` (unsigned, test stacks only) lists the last deliveries
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
  // Its tree: two spaces at the root, the second holding one more.
  sink.browse = async (req?: BrowseRequest) => ({
    nodes:
      (req?.parentId ?? null) === null
        ? [
            {
              id: 'reports',
              label: 'Reports',
              kind: 'space',
              hasChildren: false,
              selectable: true,
            },
            {
              id: 'archive',
              label: 'Archive',
              kind: 'space',
              hasChildren: true,
              selectable: false,
            },
          ]
        : req?.parentId === 'archive'
          ? [
              {
                id: 'archive/2026',
                label: '2026',
                kind: 'space',
                hasChildren: false,
                selectable: true,
              },
            ]
          : [],
    nextCursor: null,
  });
  // A name starting `taken-` is held by another document, so a smoke can show a name conflict.
  const deliver = sink.deliver.bind(sink);
  sink.deliver = async (req) => {
    const name = req.destination.name ?? '';
    if (name.startsWith('taken-')) {
      throw new SinkError(
        bridgeError('name_conflict', `another document is named ${name}`, {
          field: 'name',
          value: name,
        }),
      );
    }
    return deliver(req);
  };
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
