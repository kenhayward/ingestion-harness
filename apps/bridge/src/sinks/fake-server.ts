import { pathToFileURL } from 'node:url';
import { bridgeError, type BrowseRequest } from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';
import { FakeDocumentSink } from './fake-documents.js';
import { FakeSink } from './fake.js';
import { SinkError } from './port.js';
import { serveSink } from './serve.js';

/** What the fake serves: files and data (version 1), or decomposed documents (version 2). */
export type FakeSinkMode = 'files' | 'documents';

/** How many deliveries `/_delivered` keeps. */
const KEPT = 50;

/**
 * The fake external sink for compose smoke tests and CI (compose profile `fake-sink`): the
 * FakeSink behind the sink contract's signed routes, with a shared connection kind, a browsable
 * fixed field `space` and an overridable name pattern `name`. It replaces what an idempotency
 * key delivered before, and refuses a name starting `taken-` (`name_conflict`). `GET /_delivered` (unsigned, test stacks only) lists the last deliveries
 * without their bytes, and how many keys it holds.
 *
 * In `documents` mode (env `FAKE_SINK_MODE=documents`) it serves the FakeDocumentSink instead,
 * with an unsigned `POST /_edit` (`{persistentId, componentId}`, test stacks only) that changes one
 * component in the target, answering the component's new version or 404, and an unsigned
 * `POST /_delete` (`{persistentId}`) that deletes a document in the target (204, or 404).
 */
export async function buildFakeServer(
  key: string,
  logger = false,
  mode: FakeSinkMode = 'files',
): Promise<FastifyInstance> {
  if (mode === 'documents') return buildDocumentServer(key, logger);
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

/**
 * The `documents` mode server: `sink` behind the signed routes, with `/_edit` and `/_delete`. A
 * test passes its own sink to see what was delivered.
 */
export async function buildDocumentServer(
  key: string,
  logger = false,
  sink = new FakeDocumentSink(),
): Promise<FastifyInstance> {
  const app = await serveSink(sink, key, { unsigned: ['/_edit', '/_delete'], logger });
  app.post('/_edit', async (req, reply) => {
    const body = (req.body ?? {}) as { persistentId?: unknown; componentId?: unknown };
    const edited =
      typeof body.persistentId === 'string' && typeof body.componentId === 'string'
        ? sink.edit(body.persistentId, body.componentId)
        : null;
    if (!edited) return reply.code(404).send(bridgeError('not_found', 'no such component'));
    return edited;
  });
  app.post('/_delete', async (req, reply) => {
    const { persistentId } = (req.body ?? {}) as { persistentId?: unknown };
    if (typeof persistentId === 'string' && sink.remove(persistentId)) {
      return reply.code(204).send();
    }
    return reply.code(404).send(bridgeError('not_found', 'no such document'));
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.FAKE_SINK_KEY ?? '';
  if (key.length < 32) {
    console.error('FAKE_SINK_KEY must be at least 32 characters');
    process.exit(2);
  }
  const mode = process.env.FAKE_SINK_MODE === 'documents' ? 'documents' : 'files';
  const app = await buildFakeServer(key, true, mode);
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
}
