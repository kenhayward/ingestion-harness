import { conformanceSuite } from '@ih/bridge-contract';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSink } from '../src/sinks/fake.js';
import { HttpSink } from '../src/sinks/http.js';
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
      'errors',
    ]);
    expect(sink.delivered).toHaveLength(2);
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
