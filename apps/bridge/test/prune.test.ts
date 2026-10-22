import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { prunePackagesOnce } from '../src/packages/prune.js';
import { MemoryPackageStore } from '../src/packages/store.js';
import { pkg } from './deliveries-contract.js';
import { documentPackage } from './sink-builders.js';

const T0 = new Date('2026-10-19T12:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const user = { id: 'u1', name: 'Pat', email: null };

describe('pruning staged packages (BRIDGE_PACKAGE_RETENTION_DAYS)', () => {
  it('deletes the bytes of a package past retention once its deliveries are final, once', async () => {
    const deliveries = new MemoryDeliveryRepo();
    const packages = new MemoryPackageStore();
    const done = pkg({ stagedKey: 'packages/done.json', expiresAt: at(100) });
    const busy = pkg({ stagedKey: 'packages/busy.json', expiresAt: at(100) });
    const d = {
      id: randomUUID(),
      targetId: 't1',
      actingUser: user,
      overrides: {},
      destination: null,
    };
    await deliveries.create(done, [d], T0);
    await deliveries.create(busy, [{ ...d, id: randomUUID() }], at(1));
    await packages.put(done.stagedKey, documentPackage);
    await packages.put(busy.stagedKey, documentPackage);
    const c = await deliveries.claim(at(2), 300);
    await deliveries.transition(
      d.id,
      { status: 'succeeded', receipt: { written: [] } },
      at(3),
      c!.claimId,
    );

    expect(await prunePackagesOnce({ deliveries, packages }, at(200))).toBe(1);
    expect(await packages.get(done.stagedKey)).toBeNull();
    // Its delivery is still on its way: the runner needs the bytes.
    expect(await packages.get(busy.stagedKey)).not.toBeNull();
    expect(await prunePackagesOnce({ deliveries, packages }, at(200))).toBe(0);
  });
});
