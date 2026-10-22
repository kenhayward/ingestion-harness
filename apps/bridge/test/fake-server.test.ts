import { signRequest } from '@ih/bridge-contract';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFakeServer } from '../src/sinks/fake-server.js';
import { KEY } from './helpers.js';
import { deliverRequest } from './sink-builders.js';

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function server() {
  const app = await buildFakeServer(KEY);
  open.push(app);
  const signed = (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return app.inject({
      method,
      url,
      headers: {
        ...signRequest(KEY, { method, path: url, body: payload }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload }),
    });
  };
  return { app, signed };
}

describe('the fake external sink server', () => {
  it('describes a shared sink with a browsable space and an overridable name pattern', async () => {
    const { signed } = await server();
    const res = await signed('GET', '/describe');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Fake sink',
      connectionKind: 'shared',
      destinationFields: [
        { id: 'space', kind: 'fixed', required: true, browse: true },
        { id: 'name', kind: 'pattern', required: true, overridable: true },
      ],
      capabilities: { replace: true, withdraw: false, accepts: ['files', 'data'] },
    });
  });

  it('refuses unsigned sink routes', async () => {
    const { app } = await server();
    expect((await app.inject('/describe')).statusCode).toBe(401);
  });

  it('lists what it was delivered without bytes, and how many keys it holds', async () => {
    const { app, signed } = await server();
    const req = deliverRequest({ destination: { space: 's', name: 'n' } });
    expect((await signed('POST', '/deliveries', req)).statusCode).toBe(200);
    expect((await signed('POST', '/deliveries', req)).statusCode).toBe(200);
    const res = await app.inject('/_delivered');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys).toBe(1);
    expect(body.deliveries).toHaveLength(2);
    expect(body.deliveries[0]).toMatchObject({
      idempotencyKey: req.idempotencyKey,
      destination: { space: 's', name: 'n' },
    });
    expect(JSON.stringify(body)).not.toContain(req.package.files[0]!.content);
  });
});
