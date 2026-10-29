import { describe, expect, it } from 'vitest';
import { BridgeErrorSchema, SOURCE_PATHS, signRequest } from '../src/index.js';
import { SOURCES_KEY, SOURCES_PLACE, sourcesFake } from './sources-fake.js';

/** The test fake follows the idempotent move rule of `SOURCE_PATHS.move`. */
describe('sources fake: the idempotent move rule', () => {
  const send = async (sink: typeof fetch, path: string, extra: Record<string, unknown>) => {
    const body = JSON.stringify({
      instanceId: 'main',
      credential: {},
      source: SOURCES_PLACE,
      actingUser: null,
      ...extra,
    });
    const headers = signRequest(SOURCES_KEY, { method: 'POST', path, body });
    const res = await sink(`http://sink.test${path}`, {
      method: 'POST',
      body,
      headers: { ...headers, 'content-type': 'application/json' },
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as unknown) : undefined };
  };
  const put = (sink: typeof fetch, folder: string, content: string) =>
    send(sink, SOURCE_PATHS.put, { folder, name: 'a.txt', content });
  const move = (sink: typeof fetch) =>
    send(sink, SOURCE_PATHS.move, {
      from: { folder: '', name: 'a.txt' },
      to: { folder: 'processing', name: 'a.txt' },
    });
  const list = async (sink: typeof fetch, folder: string) =>
    ((await send(sink, SOURCE_PATHS.list, { folder })).json as { files: { size: number }[] }).files;

  it('source gone, destination there: success', async () => {
    const sink = sourcesFake();
    await put(sink, '', 'abc');
    expect((await move(sink)).status).toBe(204);
    expect((await move(sink)).status).toBe(204);
  });

  it('both there with equal sizes: the source is deleted, success', async () => {
    const sink = sourcesFake();
    await put(sink, '', 'abc');
    await put(sink, 'processing', 'xyz');
    expect((await move(sink)).status).toBe(204);
    expect(await list(sink, '')).toEqual([]);
    expect((await list(sink, 'processing')).map((f) => f.size)).toEqual([3]);
  });

  it('both there with different sizes: destination_exists, nothing changed', async () => {
    const sink = sourcesFake();
    await put(sink, '', 'abc');
    await put(sink, 'processing', 'longer');
    const res = await move(sink);
    const error = BridgeErrorSchema.parse(res.json);
    expect(error).toMatchObject({ code: 'destination_exists', class: 'needs_user' });
    expect(error.details?.reason).toBeUndefined();
    expect((await list(sink, '')).map((f) => f.size)).toEqual([3]);
    expect((await list(sink, 'processing')).map((f) => f.size)).toEqual([6]);
  });

  it('neither there: not_found', async () => {
    const res = await move(sourcesFake());
    expect(BridgeErrorSchema.parse(res.json).code).toBe('not_found');
  });
});
