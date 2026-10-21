import { describe, expect, it } from 'vitest';
import type { TargetMirror } from '../src/bridge/client.js';
import { FakeBridgeApi } from './fake-bridge.js';

const lake: TargetMirror = {
  label: 'Lake',
  sinkId: 's3',
  instanceId: null,
  connectionId: 'internal',
  destination: { bucket: 'lake', prefix: 'out/', sse: 'none', kmsKeyId: '', storageClass: '' },
};

/** The fake answers as the real bridge does, so tests cannot pass on what the bridge refuses. */
describe('FakeBridgeApi', () => {
  it('reads only inside a target it holds: its bucket, under its prefix', async () => {
    const bridge = new FakeBridgeApi();
    await bridge.putTarget('lake', lake);
    bridge.put('lake', 'lake', 'out/a.csv', 'a');
    expect((await bridge.readObject('lake', 'lake', 'out/a.csv'))?.toString()).toBe('a');
    expect(await bridge.readObject('lake', 'lake', 'out/none.csv')).toBeNull();
    await expect(bridge.readObject('nope', 'lake', 'out/a.csv')).rejects.toMatchObject({
      status: 404,
      error: { code: 'target_missing' },
    });
    for (const [bucket, key] of [
      ['other', 'out/a.csv'],
      ['lake', 'elsewhere/a.csv'],
    ] as const) {
      await expect(bridge.readObject('lake', bucket, key)).rejects.toMatchObject({
        status: 422,
        error: { code: 'content_rejected', message: 'the object is outside the target' },
      });
    }
  });

  it('keeps a removed target removed, and its id taken', async () => {
    const bridge = new FakeBridgeApi();
    await bridge.putTarget('lake', lake);
    expect(await bridge.deleteTarget('lake')).toBe('deleted');
    await expect(bridge.putTarget('lake', lake)).rejects.toMatchObject({
      status: 409,
      error: { code: 'name_conflict' },
    });
    expect(bridge.targets.has('lake')).toBe(false);
  });
});
