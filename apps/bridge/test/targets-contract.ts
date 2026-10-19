import { describe, expect, it } from 'vitest';
import type { Target, TargetRepo } from '../src/targets/repo.js';

const target = (id: string, over: Partial<Target> = {}): Target => ({
  id,
  label: `Target ${id}`,
  sinkId: 'fake',
  instanceId: null,
  connectionId: null,
  destination: { bucket: 'b', prefix: 'out/' },
  ...over,
});

/** The behaviour every TargetRepo shares; `make` gives an empty repo. */
export function targetsContract(name: string, make: () => Promise<TargetRepo>): void {
  describe(`TargetRepo (${name})`, () => {
    it('puts, gets and lists targets by id', async () => {
      const repo = await make();
      await repo.put(target('b'));
      await repo.put(target('a', { instanceId: 'sandbox' }));
      expect(await repo.get('a')).toEqual(target('a', { instanceId: 'sandbox' }));
      expect(await repo.get('missing')).toBeNull();
      expect((await repo.list()).map((t) => t.id)).toEqual(['a', 'b']);
    });

    it('put overwrites', async () => {
      const repo = await make();
      await repo.put(target('a'));
      await repo.put(target('a', { label: 'Renamed', destination: { bucket: 'c' } }));
      expect(await repo.get('a')).toMatchObject({ label: 'Renamed', destination: { bucket: 'c' } });
      expect(await repo.list()).toHaveLength(1);
    });

    it('remove deletes the target, and says when there was none', async () => {
      const repo = await make();
      await repo.put(target('a'));
      expect(await repo.remove('a')).toBe(true);
      expect(await repo.get('a')).toBeNull();
      expect(await repo.remove('a')).toBe(false);
    });
  });
}
