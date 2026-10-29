import { changedInTargetDetails, MemoryNonceStore, verifyRequest } from '@ih/bridge-contract';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSink } from '../src/sinks/fake.js';
import { FakeDocumentSink } from '../src/sinks/fake-documents.js';
import { HttpSink } from '../src/sinks/http.js';
import { SinkError } from '../src/sinks/port.js';
import { serveSink } from '../src/sinks/serve.js';
import { KEY } from './helpers.js';
import { decomposedPackage, deliverRequest } from './sink-builders.js';

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

  it('describe v4 and a document receipt parse', async () => {
    const fake = new FakeDocumentSink();
    const sink = adapter(await listen(await serveSink(fake, KEY)));
    const described = await sink.describe();
    expect(described).toEqual(await fake.describe());
    expect(described.contractVersion).toBe(4);
    const created = await sink.deliver(
      deliverRequest({
        destination: { space: 'S' },
        idempotencyKey: decomposedPackage.idempotencyKey,
        package: decomposedPackage,
      }),
    );
    expect(created).toMatchObject({
      status: 'succeeded',
      receipt: { document: { persistentId: 'doc-1', readBack: { ok: true } } },
    });
    const components = created.status === 'succeeded' ? created.receipt.document!.components : [];
    fake.edit('doc-1', 'doc-1/map');
    const refused = await failure(
      sink.deliver(
        deliverRequest({
          destination: { space: 'S' },
          idempotencyKey: 'e'.repeat(64),
          package: { ...decomposedPackage, idempotencyKey: 'e'.repeat(64) },
          update: { persistentId: 'doc-1', expected: components },
        }),
      ),
    );
    expect(refused.error).toMatchObject({
      class: 'needs_user',
      code: 'changed_in_target',
      details: { changed: [{ id: 'doc-1/map', expected: '1', actual: '2' }] },
    });
  });

  it('a changed_in_target refusal keeps its details at the 4 KB bound', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `doc-1/section/${'s'.repeat(60)}-${i}`,
      expected: '1',
      actual: '2',
    }));
    const details = changedInTargetDetails(many);
    const url = await stub(422, {
      class: 'needs_user',
      code: 'changed_in_target',
      message: 'changed',
      details,
    });
    const err = await failure(adapter(url).deliver(deliverRequest()));
    expect(err.error.details).toEqual(details);
    expect(err.error.details).toHaveProperty('more');
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

describe('HttpSink, a sink that misbehaves mid-answer', () => {
  it('a body that stalls after the headers is a timeout', async () => {
    const app = Fastify();
    app.get('/describe', (_req, reply) => {
      reply.raw.writeHead(200, { 'content-type': 'application/json' });
      reply.raw.write('{"name":');
      // …and never another byte.
    });
    const err = await failure(
      adapter(await listen(app), KEY, { short: 200, long: 200 }).describe(),
    );
    expect(err.error).toMatchObject({ class: 'retryable', code: 'timeout' });
  });

  it('a connection dropped mid-body is unavailable', async () => {
    const app = Fastify();
    app.get('/describe', (req, reply) => {
      reply.raw.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
      reply.raw.write('{"name":');
      setTimeout(() => req.raw.socket.destroy(), 20);
    });
    const err = await failure(adapter(await listen(app)).describe());
    expect(err.error).toMatchObject({ class: 'retryable', code: 'sink_unavailable' });
  });

  it("a sink's error is bounded, and a known code keeps its own class", async () => {
    const huge = 'x'.repeat(100_000);
    const url = await stub(422, {
      class: 'retryable',
      code: 'credential_rejected',
      message: huge,
      details: { blob: huge },
    });
    const err = await failure(adapter(url).deliver(deliverRequest()));
    expect(err.error.class).toBe('needs_user');
    expect(err.error.code).toBe('credential_rejected');
    expect(err.error.message.length).toBeLessThanOrEqual(500);
    expect(err.error.details).toBeUndefined();
    const small = await failure(
      adapter(
        await stub(422, {
          class: 'needs_user',
          code: 'name_conflict',
          message: 'taken',
          details: { field: 'name' },
        }),
      ).deliver(deliverRequest()),
    );
    expect(small.error.details).toEqual({ field: 'name' });
  });
});

describe('HttpSink, watched folders', () => {
  const where = {
    instanceId: 'main',
    credential: {},
    source: { folder: 'inbox' },
    actingUser: null,
  };

  it('lists, reads, moves and puts through the sink contract routes', async () => {
    const docs = new FakeDocumentSink();
    docs.drop('a.pdf', Buffer.from('abc'));
    const sink = adapter(await listen(await serveSink(docs, KEY)));
    expect((await sink.sources.list({ ...where, folder: '' })).map((f) => f.name)).toEqual([
      'a.pdf',
    ]);
    await sink.sources.move({
      ...where,
      from: { folder: '', name: 'a.pdf' },
      to: { folder: 'processing', name: 'a.pdf' },
    });
    expect(await sink.sources.read({ ...where, folder: 'processing', name: 'a.pdf' }, 10)).toEqual(
      Buffer.from('abc'),
    );
    await sink.sources.put({ ...where, folder: 'failed', name: 'a.pdf.md', content: 'why' });
    expect(docs.folder('failed')?.map((f) => f.size)).toEqual([3]);
  });

  it('refuses a read past maxBytes as it streams, without a content length', async () => {
    const app = Fastify();
    app.post('/sources:read', (_req, reply) => {
      reply.raw.writeHead(200, { 'content-type': 'application/octet-stream' });
      // Chunks with no declared length: only counting them finds the file too large.
      for (let i = 0; i < 40; i += 1) reply.raw.write(Buffer.alloc(64 * 1024, 1));
      reply.raw.end();
    });
    const err = await failure(
      adapter(await listen(app)).sources.read({ ...where, folder: '', name: 'big.pdf' }, 100_000),
    );
    expect(err.error).toMatchObject({
      code: 'content_rejected',
      details: { reason: 'too_large', maxBytes: 100_000 },
    });
  });

  it("keeps a sink's own refusal of a missing folder", async () => {
    const sink = adapter(await listen(await serveSink(new FakeDocumentSink(), KEY)));
    const err = await failure(
      sink.sources.list({ ...where, source: { folder: 'nowhere' }, folder: '' }),
    );
    expect(err.error).toMatchObject({ code: 'not_found', details: { reason: 'folder_missing' } });
  });
});
