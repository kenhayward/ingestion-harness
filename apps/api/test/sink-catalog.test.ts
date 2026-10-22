import { describe, expect, it, vi } from 'vitest';
import { SinkCatalog } from '../src/bridge/sinks.js';
import { FakeBridgeApi } from './fake-bridge.js';
import { FAKE_SINK } from './sink-targets-routes.test.js';

describe('SinkCatalog', () => {
  it('keeps what the bridge last listed when the bridge cannot say', async () => {
    const bridge = new FakeBridgeApi();
    bridge.sinkViews = [FAKE_SINK];
    const catalog = new SinkCatalog({ ttlMs: 0 });
    expect(catalog.get('fake')).toBeUndefined();
    expect(await catalog.refresh(bridge)).toBe(true);
    expect(catalog.get('fake')?.name).toBe('Fake sink');
    bridge.failNext = new Error('connect ECONNREFUSED');
    expect(await catalog.refresh(bridge)).toBe(false);
    expect(catalog.all()).toEqual([FAKE_SINK]);
  });
});

describe('SinkCatalog, kept fresh without a call per request', () => {
  it('asks the bridge again only after its time to live, a failure included', async () => {
    const bridge = new FakeBridgeApi();
    bridge.sinkViews = [FAKE_SINK];
    let now = 1_000_000;
    const listSinks = vi.spyOn(bridge, 'listSinks');
    const catalog = new SinkCatalog({ ttlMs: 30_000, now: () => now });
    await catalog.refresh(bridge);
    await catalog.refresh(bridge);
    expect(listSinks).toHaveBeenCalledTimes(1);
    now += 30_001;
    bridge.failNext = new Error('connect ECONNREFUSED');
    expect(await catalog.refresh(bridge)).toBe(false);
    await catalog.refresh(bridge);
    expect(listSinks).toHaveBeenCalledTimes(2);
    expect(catalog.get('fake')?.name).toBe('Fake sink');
    await catalog.refresh(bridge, { force: true });
    expect(listSinks).toHaveBeenCalledTimes(3);
  });
});
