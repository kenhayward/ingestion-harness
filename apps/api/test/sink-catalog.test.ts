import { describe, expect, it } from 'vitest';
import { SinkCatalog } from '../src/bridge/sinks.js';
import { FakeBridgeApi } from './fake-bridge.js';
import { FAKE_SINK } from './sink-targets-routes.test.js';

describe('SinkCatalog', () => {
  it('keeps what the bridge last listed when the bridge cannot say', async () => {
    const bridge = new FakeBridgeApi();
    bridge.sinkViews = [FAKE_SINK];
    const catalog = new SinkCatalog();
    expect(catalog.get('fake')).toBeUndefined();
    expect(await catalog.refresh(bridge)).toBe(true);
    expect(catalog.get('fake')?.name).toBe('Fake sink');
    bridge.failNext = new Error('connect ECONNREFUSED');
    expect(await catalog.refresh(bridge)).toBe(false);
    expect(catalog.all()).toEqual([FAKE_SINK]);
  });
});
