import { describe, expect, it } from 'vitest';
import { testBridge } from './helpers.js';

describe('health', () => {
  it('answers health unsigned', async () => {
    const app = await testBridge();
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('answers readiness from its deps', async () => {
    expect(
      (await (await testBridge({ ready: async () => true })).inject('/readyz')).json(),
    ).toEqual({ status: 'ready' });
    const notReady = await (await testBridge({ ready: async () => false })).inject('/readyz');
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toEqual({ status: 'not ready' });
  });
});
