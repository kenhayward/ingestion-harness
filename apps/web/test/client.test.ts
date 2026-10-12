import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/client.js';

const respond = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('http api: ended sessions', () => {
  it('reports a 401 from any call, including token management', async () => {
    const api = createHttpApi('/api');
    const ended = vi.fn();
    const off = api.onUnauthorized(ended);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(401, { error: 'sign in required' })),
    );
    await expect(api.listJobs()).rejects.toThrow('sign in required');
    await expect(api.listTokens()).rejects.toThrow('sign in required');
    expect(ended).toHaveBeenCalledTimes(2);
    off();
  });

  it('does not treat sign-in and the startup check as an ended session', async () => {
    const api = createHttpApi('/api');
    const ended = vi.fn();
    const off = api.onUnauthorized(ended);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(401, { error: 'invalid or expired token' })),
    );
    expect(await api.me()).toBeNull();
    await expect(api.login('ih_x')).rejects.toMatchObject({ status: 401 });
    expect(ended).not.toHaveBeenCalled();
    off();
  });
});

describe('http api: URLs', () => {
  it('links the uploaded PDF of a job', () => {
    expect(createHttpApi('/api').documentUrl('j1')).toBe('/api/jobs/j1/document');
  });
});

describe('http api: results query', () => {
  it('sends the file name filter with the other parameters', async () => {
    const fetch = vi.fn(async () => respond(200, []));
    vi.stubGlobal('fetch', fetch);
    await createHttpApi('/api').listResults({
      templateId: 't',
      q: 'a b%',
      before: 'x',
      beforeId: 'y',
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/results?templateId=t&q=a+b%25&before=x&beforeId=y',
      undefined,
    );
  });
});

describe('http api: long results filter', () => {
  it('clamps q to the 100 characters the API accepts', async () => {
    const fetch = vi.fn(async () => respond(200, []));
    vi.stubGlobal('fetch', fetch);
    await createHttpApi('/api').listResults({ q: 'x'.repeat(150) });
    expect(fetch).toHaveBeenCalledWith(`/api/results?q=${'x'.repeat(100)}`, undefined);
  });
});
