import { MemoryNonceStore, verifyRequest } from '@ih/bridge-contract';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSink } from '../src/sinks/fake.js';
import { HttpSink } from '../src/sinks/http.js';
import { SinkError } from '../src/sinks/port.js';
import { serveSink } from '../src/sinks/serve.js';
import { KEY } from './helpers.js';
import { deliverRequest } from './sink-builders.js';

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function listen(app: FastifyInstance): Promise<string> {
  open.push(app);
  return app.listen({ host: '127.0.0.1', port: 0 });
}

/** A sink at `url`, reached the way the bridge reaches one. */
const adapter = (url: string, key = KEY, timeouts = { short: 2_000, long: 2_000 }) =>
  new HttpSink({ id: 'fake', url, key, timeouts });

/** The SinkError a call failed with. */
async function failure(call: Promise<unknown>): Promise<SinkError> {
  const err = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SinkError);
  return err as SinkError;
}

/** A sink that answers every request with `status` and `body`. */
async function stub(status: number, body: unknown, delayMs = 0): Promise<string> {
  const app = Fastify();
  app.all('/*', async (_req, reply) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return reply
      .code(status)
      .header('content-type', 'application/json')
      .send(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return listen(app);
}

describe('HttpSink', () => {
  it('describes, tests, browses, delivers and polls as the sink answers', async () => {
    const fake = new FakeSink({ name: 'Remote' }).script('pending').scriptStatus('succeed');
    const sink = adapter(await listen(await serveSink(fake, KEY)));
    expect(await sink.describe()).toEqual(await fake.describe());
    expect(await sink.testConnection({ instanceId: 'a', credential: { username: 'pat' } })).toEqual(
      { ok: true, identity: 'fake:pat' },
    );
    expect(
      await sink.browse({
        instanceId: '',
        credential: null,
        field: 'bucket',
        parentId: null,
        cursor: null,
      }),
    ).toEqual({ nodes: [], nextCursor: null });
    const delivered = await sink.deliver(deliverRequest());
    expect(delivered).toEqual({ status: 'pending', sinkJobId: 'fake-1' });
    expect(await sink.deliveryStatus('fake-1')).toEqual({
      status: 'succeeded',
      receipt: { written: [] },
    });
    expect(fake.delivered).toHaveLength(1);
  });

  it('signs every request so the sink can verify it', async () => {
    const seen: { method: string; path: string; body: string; headers: Record<string, string> }[] =
      [];
    const app = Fastify();
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, b, done) =>
      done(null, b),
    );
    app.all('/*', async (req, reply) => {
      seen.push({
        method: req.method,
        path: req.url,
        body: typeof req.body === 'string' ? req.body : '',
        headers: req.headers as Record<string, string>,
      });
      return reply.send({ ok: true, identity: 'x' });
    });
    const sink = adapter(await listen(app));
    await sink.testConnection({ instanceId: 'a', credential: {} });
    expect(verifyRequest(KEY, seen[0]!, new MemoryNonceStore())).toEqual({ ok: true });
    expect(verifyRequest('another-key'.repeat(4), seen[0]!, new MemoryNonceStore())).toMatchObject({
      ok: false,
    });
  });

  it('a needs_user refusal keeps its class, code and details', async () => {
    const url = await stub(422, {
      class: 'needs_user',
      code: 'name_conflict',
      message: 'that name is taken',
      details: { field: 'name' },
    });
    const err = await failure(adapter(url).deliver(deliverRequest()));
    expect(err.error).toEqual({
      class: 'needs_user',
      code: 'name_conflict',
      message: 'that name is taken',
      details: { field: 'name' },
    });
  });

  it('a 503, a timeout and a refused connection are retryable', async () => {
    const down = await failure(
      adapter(
        await stub(503, { class: 'retryable', code: 'instance_unavailable', message: 'x' }),
      ).describe(),
    );
    expect(down.error).toMatchObject({ class: 'retryable', code: 'instance_unavailable' });
    const slow = await failure(
      adapter(await stub(200, {}, 500), KEY, { short: 50, long: 50 }).describe(),
    );
    expect(slow.error).toMatchObject({ class: 'retryable', code: 'timeout' });
    const refused = await failure(adapter('http://127.0.0.1:1').describe());
    expect(refused.error).toMatchObject({ class: 'retryable', code: 'sink_unavailable' });
  });

  it('a 401 says the signature was refused', async () => {
    const real = await listen(await serveSink(new FakeSink(), KEY));
    const err = await failure(adapter(real, 'w'.repeat(32)).describe());
    expect(err.error).toMatchObject({
      code: 'internal',
      message: "the sink refused the bridge's signature: check its key",
    });
  });

  it('an answer that breaks the contract is internal, and not echoed', async () => {
    const err = await failure(adapter(await stub(200, { secretish: 'leak-me' })).describe());
    expect(err.error).toMatchObject({
      code: 'internal',
      message: "the sink's answer is not valid",
    });
    expect(JSON.stringify(err.error)).not.toContain('leak-me');
    const garbage = await failure(adapter(await stub(200, '{not json')).describe());
    expect(garbage.error).toMatchObject({ code: 'internal' });
  });

  it('an error body that is not a contract error is classed by its status', async () => {
    const err = await failure(
      adapter(await stub(422, { error: 'nope' })).deliver(deliverRequest()),
    );
    expect(err.error).toMatchObject({ code: 'internal', message: 'the sink answered 422' });
    const five = await failure(adapter(await stub(500, 'oops')).describe());
    expect(five.error).toMatchObject({ class: 'retryable', code: 'sink_unavailable' });
  });

  it('an answer over 8 MiB is refused', async () => {
    const big = JSON.stringify({
      status: 'succeeded',
      receipt: { written: [] },
      pad: 'x'.repeat(9 * 2 ** 20),
    });
    const err = await failure(adapter(await stub(200, big)).deliver(deliverRequest()));
    expect(err.error).toMatchObject({
      code: 'internal',
      message: "the sink's answer is too large",
    });
  });
});
