import { signRequest } from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { KEY, signedInject, testBridge } from './helpers.js';

/** A bridge with two throwaway signed routes to guard. */
async function guarded(): Promise<FastifyInstance> {
  const app = await testBridge();
  app.get('/v1/ping', async () => ({ pong: true }));
  app.post('/v1/echo', async (req) => ({ got: req.body }));
  return app;
}

describe('signed-request guard', () => {
  it('refuses an unsigned request with the reason', async () => {
    const res = await (await guarded()).inject('/v1/ping');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      class: 'needs_user',
      code: 'credential_rejected',
      details: { reason: 'missing' },
    });
  });

  it('accepts a signed request and parses its JSON body', async () => {
    const app = await guarded();
    expect((await signedInject(app, KEY, { method: 'GET', url: '/v1/ping' })).json()).toEqual({
      pong: true,
    });
    const echoed = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/echo',
      body: { a: 1 },
    });
    expect(echoed.statusCode).toBe(200);
    expect(echoed.json()).toEqual({ got: { a: 1 } });
  });

  it('refuses the same signed request sent twice', async () => {
    const app = await guarded();
    const body = JSON.stringify({ a: 1 });
    const headers = {
      ...signRequest(KEY, { method: 'POST', path: '/v1/echo', body }),
      'content-type': 'application/json',
    };
    expect(
      (await app.inject({ method: 'POST', url: '/v1/echo', headers, payload: body })).statusCode,
    ).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/v1/echo', headers, payload: body });
    expect(again.statusCode).toBe(401);
    expect(again.json().details).toEqual({ reason: 'replayed' });
  });

  it('refuses a body changed after signing', async () => {
    const app = await guarded();
    const headers = {
      ...signRequest(KEY, { method: 'POST', path: '/v1/echo', body: '{"a":1}' }),
      'content-type': 'application/json',
    };
    const res = await app.inject({ method: 'POST', url: '/v1/echo', headers, payload: '{"a":2}' });
    expect(res.statusCode).toBe(401);
    expect(res.json().details).toEqual({ reason: 'bad_signature' });
  });

  it('leaves health unsigned and tags every response with a request id', async () => {
    const app = await guarded();
    const health = await app.inject('/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.headers['x-request-id']).toBeTruthy();
    const refused = await app.inject({ url: '/v1/ping', headers: { 'x-request-id': 'abc-123' } });
    expect(refused.headers['x-request-id']).toBe('abc-123');
  });
});
