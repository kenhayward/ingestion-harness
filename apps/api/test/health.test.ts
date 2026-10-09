import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

describe('health', () => {
  it('GET /healthz returns ok', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz reports 503 when a dependency is down', async () => {
    const { app, repo } = await testApp();
    repo.ping = async () => {
      throw new Error('connection refused');
    };
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ db: 'connection refused', storage: 'ok' });
  });
});
