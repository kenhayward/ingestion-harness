import { describe, expect, it } from 'vitest';
import { BridgeApiError, HttpBridgeApi } from '../src/bridge/client.js';
import { TEST_BRIDGE_KEY } from './helpers.js';

/** A client whose every call is answered with `status` and `body`. */
const answering = (status: number, body: unknown) =>
  new HttpBridgeApi(
    'http://bridge:3100',
    TEST_BRIDGE_KEY,
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  );

describe('HttpBridgeApi.readObject', () => {
  it('reads an object as bytes', async () => {
    const api = answering(200, { content: Buffer.from('a,b').toString('base64') });
    expect((await api.readObject('finance', 'b', 'k'))?.toString()).toBe('a,b');
  });

  it('answers null for a missing object', async () => {
    const api = answering(404, { class: 'needs_user', code: 'not_found', message: 'no such key' });
    expect(await api.readObject('finance', 'b', 'k')).toBeNull();
  });

  it('throws for a target the bridge lacks, rather than calling the object missing', async () => {
    const api = answering(404, {
      class: 'needs_user',
      code: 'target_missing',
      message: 'no target finance',
    });
    const err = await api.readObject('finance', 'b', 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeApiError);
    expect(err).toMatchObject({ status: 404, error: { code: 'target_missing' } });
  });
});
