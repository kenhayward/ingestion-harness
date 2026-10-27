import { MemoryNonceStore, verifyRequest } from '@ih/bridge-contract';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpSink } from '../src/sinks/http.js';
import { SinkError } from '../src/sinks/port.js';
import { KEY } from './helpers.js';

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

const admin = { id: 'u1', name: 'Ada Admin' };
const instance = {
  id: 'north',
  label: 'North',
  fields: { address: 'https://north.example.test' },
  locked: false,
  createdAt: '2026-10-27T09:00:00.000Z',
  createdBy: admin,
};

interface Seen {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string>;
}

/** A sink answering every call with `status` and `body`, keeping what it was sent. */
async function sinkAt(status: number, body: unknown): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
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
    return reply.code(status).send(body);
  });
  open.push(app);
  return { url: await app.listen({ host: '127.0.0.1', port: 0 }), seen };
}

const adapter = (url: string) =>
  new HttpSink({ id: 'admin-sink', url, key: KEY, timeouts: { short: 2_000, long: 2_000 } });

async function failure(call: Promise<unknown>): Promise<SinkError> {
  const err = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SinkError);
  return err as SinkError;
}

describe('HttpSink administration calls', () => {
  it("posts a call, signed, to its path with the id, and answers the sink's answer", async () => {
    const { url, seen } = await sinkAt(200, instance);
    const request = { actingAdmin: admin, label: 'North' };
    expect(await adapter(url).admin('renameInstance', 'north', request)).toEqual(instance);
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/admin/instances/north:rename' });
    expect(JSON.parse(seen[0]!.body)).toEqual(request);
    expect(verifyRequest(KEY, seen[0]!, new MemoryNonceStore())).toEqual({ ok: true });
  });

  it('takes a 201 for an add', async () => {
    const { url, seen } = await sinkAt(201, instance);
    const request = { actingAdmin: admin, id: 'north', label: 'North', fields: {} };
    expect(await adapter(url).admin('addInstance', null, request)).toEqual(instance);
    expect(seen[0]!.path).toBe('/admin/instances');
  });

  it("refuses an answer that is not the call's: internal, never echoed", async () => {
    const { url } = await sinkAt(200, { instances: 'nope', token: 'leak-me' });
    const err = await failure(adapter(url).admin('listInstances', null, { actingAdmin: admin }));
    expect(err.error.code).toBe('internal');
    expect(err.message).not.toContain('leak-me');
  });

  it("keeps the sink's contract refusal", async () => {
    const refusal = { class: 'needs_user', code: 'locked', message: 'north is configured' };
    const { url } = await sinkAt(409, refusal);
    const err = await failure(
      adapter(url).admin('removeInstance', 'north', { actingAdmin: admin }),
    );
    expect(err.error).toEqual(refusal);
  });
});
