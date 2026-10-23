import { bridgeError, conformanceSuite } from '@ih/bridge-contract';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeDocumentSink } from '../src/sinks/fake-documents.js';
import { FakeSink } from '../src/sinks/fake.js';
import { HttpSink } from '../src/sinks/http.js';
import { SinkError, type SinkPort } from '../src/sinks/port.js';
import { serveSink } from '../src/sinks/serve.js';
import { KEY } from './helpers.js';

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function listen(app: FastifyInstance): Promise<string> {
  open.push(app);
  return app.listen({ host: '127.0.0.1', port: 0 });
}

const DOCUMENT_CHECKS = [
  'document: create',
  'document: read back',
  'document: same key again',
  'document: update with a wrong version is refused',
  'document: update with matching versions',
  'document: update retried with the same key',
];

const run = (url: string) =>
  conformanceSuite({
    url,
    key: KEY,
    instanceId: 'any',
    credential: null,
    destination: { bucket: 'b' },
  });

describe('conformance suite', () => {
  it('passes every check against the fake sink served over HTTP', async () => {
    const sink = new FakeSink().script('pending').scriptStatus('pending', 'succeed');
    const url = await listen(await serveSink(sink, KEY));
    const results = await run(url);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual([
      'describe',
      'unsigned refused',
      'replay refused',
      'tampered body refused',
      'connections:test',
      'browse',
      'deliver',
      'same key again',
      ...DOCUMENT_CHECKS,
      'errors',
    ]);
    for (const name of DOCUMENT_CHECKS) {
      expect(results.find((r) => r.name === name)).toEqual({
        name,
        ok: true,
        detail: 'skipped: the sink does not take decomposed documents',
      });
    }
    expect(sink.delivered).toHaveLength(2);
  });

  it('passes every check against the fake document sink, which conforms with documents only', async () => {
    const sink = new FakeDocumentSink();
    const results = await run(await listen(await serveSink(sink, KEY)));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual([
      'describe',
      'unsigned refused',
      'replay refused',
      'tampered body refused',
      'connections:test',
      'browse',
      'deliver',
      'same key again',
      ...DOCUMENT_CHECKS,
      'errors',
    ]);
    // The version 1 delivery checks are covered by the document checks for a documents-only sink.
    for (const name of ['deliver', 'same key again']) {
      expect(results.find((r) => r.name === name)?.detail).toBe(
        'skipped: the sink takes documents, not files (the document checks cover it)',
      );
    }
    for (const name of DOCUMENT_CHECKS) {
      expect(results.find((r) => r.name === name)?.detail ?? '').not.toMatch(/^skipped/);
    }
    // One document created, then updated in place; the refused update changed nothing.
    expect(sink.documents.size).toBe(1);
  });

  it('gives each run its own keys, so the suite runs again against the same sink', async () => {
    const url = await listen(await serveSink(new FakeDocumentSink(), KEY));
    expect((await run(url)).filter((r) => !r.ok)).toEqual([]);
    expect((await run(url)).filter((r) => !r.ok)).toEqual([]);
  });

  it('fails a document sink that refuses a retried update as changed', async () => {
    const inner = new FakeDocumentSink();
    const seen = new Set<string>();
    // Right in everything but a retry: it checks the versions again instead of the key.
    const forgetful: SinkPort = {
      describe: () => inner.describe(),
      testConnection: (req) => inner.testConnection(req),
      browse: () => inner.browse(),
      deliveryStatus: (id) => inner.deliveryStatus(id),
      deliver: async (req) => {
        if (req.update && seen.has(req.idempotencyKey)) {
          throw new SinkError(
            bridgeError('changed_in_target', 'changed', { changed: [{ id: 'x' }] }),
          );
        }
        seen.add(req.idempotencyKey);
        return inner.deliver(req);
      },
    };
    const results = await run(await listen(await serveSink(forgetful, KEY)));
    expect(results.filter((r) => !r.ok).map((r) => r.name)).toEqual([
      'document: update retried with the same key',
    ]);
  });

  it('fails a document sink that applies an update whatever the versions', async () => {
    const inner = new FakeDocumentSink();
    const careless: SinkPort = {
      describe: () => inner.describe(),
      testConnection: (req) => inner.testConnection(req),
      browse: () => inner.browse(),
      deliveryStatus: (id) => inner.deliveryStatus(id),
      // Whatever the update expects, it writes over what the target holds.
      deliver: async (req) => {
        const stored = req.update && inner.documents.get(req.update.persistentId);
        if (!req.update || !stored) return inner.deliver(req);
        const expected = [...stored.components].map(([id, c]) => ({
          kind: c.kind,
          id,
          version: `${c.version}`,
          element: c.element,
        }));
        return inner.deliver({ ...req, update: { ...req.update, expected } });
      },
    };
    const results = await run(await listen(await serveSink(careless, KEY)));
    expect(
      results.find((r) => r.name === 'document: update with a wrong version is refused'),
    ).toMatchObject({ ok: false, detail: 'the update was applied' });
  });

  it('fails a sink that only checks the signature headers are present', async () => {
    const real = await serveSink(new FakeSink(), KEY);
    open.push(real);
    const lax = Fastify();
    lax.all('/*', async (req, reply) => {
      if (!req.headers['x-bridge-signature']) return reply.code(401).send({});
      const res = await real.inject({
        method: 'GET',
        url: '/describe',
        headers: req.headers as Record<string, string>,
      });
      return reply.code(200).header('content-type', 'application/json').send(res.body);
    });
    const results = await run(await listen(lax));
    expect(results.find((r) => r.name === 'replay refused')).toMatchObject({ ok: false });
    expect(results.find((r) => r.name === 'tampered body refused')).toMatchObject({ ok: false });
  });

  it('fails a sink whose error bodies break the contract', async () => {
    const real = await serveSink(new FakeSink(), KEY);
    open.push(real);
    // A sink that is right in everything but its delivery errors.
    const bad = Fastify();
    bad.all('/*', async (req, reply) => {
      if (req.url.startsWith('/deliveries') && req.method === 'POST') {
        return reply.code(422).send({ error: 'nope' });
      }
      const res = await real.inject({
        method: req.method as 'GET',
        url: req.url,
        headers: req.headers as Record<string, string>,
        payload: req.body === undefined ? undefined : JSON.stringify(req.body),
      });
      return reply.code(res.statusCode).headers(res.headers).send(res.body);
    });
    const results = await run(await listen(bad));
    expect(results.find((r) => r.name === 'deliver')).toMatchObject({ ok: false });
    expect(results.find((r) => r.name === 'errors')).toMatchObject({ ok: false });
  });

  it('fails the describe of a personal sink that asks for no credential', async () => {
    const sink = new FakeSink({ connectionKind: 'personal', instances: [{ id: 'a', label: 'A' }] });
    const results = await run(await listen(await serveSink(sink, KEY)));
    expect(results.find((r) => r.name === 'describe')).toMatchObject({
      ok: false,
      detail: 'a personal sink declares the credential fields its users enter',
    });
  });
});

describe('conformance suite, more', () => {
  it('fails the describe of a sink that does not take files and data', async () => {
    const sink = new FakeSink({
      capabilities: {
        browse: false,
        replace: true,
        withdraw: false,
        readBack: false,
        accepts: ['files'],
      },
    });
    const results = await run(await listen(await serveSink(sink, KEY)));
    expect(results.find((r) => r.name === 'describe')).toMatchObject({
      ok: false,
      detail: 'a sink takes files and data (it may ignore them)',
    });
  });

  it('fails the describe of a document sink that does not take images', async () => {
    const inner = new FakeDocumentSink();
    const describe = await inner.describe();
    const sink: SinkPort = {
      describe: async () => ({
        ...describe,
        capabilities: {
          ...describe.capabilities,
          accepts: ['document'],
          decomposedDocuments: undefined,
        },
      }),
      testConnection: (req) => inner.testConnection(req),
      browse: () => inner.browse(),
      deliveryStatus: (id) => inner.deliveryStatus(id),
      deliver: (req) => inner.deliver(req),
    };
    const results = await run(await listen(await serveSink(sink, KEY)));
    expect(results.find((r) => r.name === 'describe')).toMatchObject({
      ok: false,
      detail: 'a sink takes files and data, or document and images (it may ignore them)',
    });
  });

  it('the bridge adapter and the suite agree: a sink served through HttpSink passes', async () => {
    const inner = new FakeSink({
      capabilities: {
        browse: false,
        replace: true,
        withdraw: false,
        readBack: false,
        accepts: ['files', 'data'],
      },
    });
    const first = await listen(await serveSink(inner, KEY));
    // The bridge's view of that sink, served again: what the adapter reads must stand up.
    const relayed = await listen(
      await serveSink(new HttpSink({ id: 'fake', url: first, key: KEY }), KEY),
    );
    expect((await run(relayed)).filter((r) => !r.ok)).toEqual([]);
  });
});
