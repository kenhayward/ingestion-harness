import { describe, expect, it } from 'vitest';
import type { DeliveryRepo, LaneLimits } from '../src/deliveries/repo.js';
import { delivery, pkg } from './deliveries-contract.js';

const T0 = new Date('2026-10-19T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

/** A target of one tenant: a sink and one of its instances. */
export interface LaneTarget {
  id: string;
  sinkId: string;
  instanceId: string | null;
}

/** The targets every case uses: `one` and `other` are two instances of a sink, `wide` has 10. */
export const LANE_TARGETS: LaneTarget[] = [
  { id: 'one', sinkId: 'ext', instanceId: 'i1' },
  { id: 'one-b', sinkId: 'ext', instanceId: 'i1' },
  { id: 'other', sinkId: 'ext', instanceId: 'i2' },
  { id: 'wide', sinkId: 'ext', instanceId: 'big' },
  { id: 'two', sinkId: 'ext', instanceId: 'pair' },
  { id: 'files', sinkId: 's3', instanceId: null },
];

/** The lanes of each tenant above: built-in s3 unlimited, `big` 10, `pair` 2, the rest 1. */
export const LIMITS: LaneLimits = (sinkId, instanceId) =>
  sinkId === 's3' ? null : instanceId === 'big' ? 10 : instanceId === 'pair' ? 2 : 1;

/** How every DeliveryRepo claims within a tenant's lanes; `make` gives an empty repo with LANE_TARGETS. */
export function lanesContract(name: string, make: () => Promise<DeliveryRepo>): void {
  describe(`lanes (${name})`, () => {
    it('an instance without lanes takes one delivery at a time', async () => {
      const repo = await make();
      const [d1, d2] = [delivery('one'), delivery('one-b')];
      await repo.create(pkg(), [d1, d2], T0);
      const first = await repo.claim(T0, 300, LIMITS);
      expect([d1.id, d2.id]).toContain(first?.id);
      expect(await repo.claim(T0, 300, LIMITS)).toBeNull();
      await repo.transition(
        first!.id,
        { status: 'succeeded', receipt: { written: [] } },
        at(1),
        first!.claimId,
      );
      const second = await repo.claim(at(1), 300, LIMITS);
      expect(second?.id).toBe(first!.id === d1.id ? d2.id : d1.id);
    });

    it('lanes 10 lets ten run', async () => {
      const repo = await make();
      await repo.create(
        pkg(),
        Array.from({ length: 12 }, () => delivery('wide')),
        T0,
      );
      const claimed = [];
      for (let n = 0; n < 10; n++) claimed.push(await repo.claim(T0, 300, LIMITS));
      expect(claimed.every((c) => c !== null)).toBe(true);
      expect(await repo.claim(T0, 300, LIMITS)).toBeNull();
    });

    it('tenants do not block each other', async () => {
      const repo = await make();
      await repo.create(pkg(), [delivery('one'), delivery('one'), delivery('other')], T0);
      const claimed = [await repo.claim(T0, 300, LIMITS), await repo.claim(T0, 300, LIMITS)].map(
        (c) => c?.targetId,
      );
      expect(claimed.sort()).toEqual(['one', 'other']);
      expect(await repo.claim(T0, 300, LIMITS)).toBeNull();
    });

    it('a waiting delivery holds its lane and can always be polled', async () => {
      const repo = await make();
      const d1 = delivery('one');
      await repo.create(pkg(), [d1], T0);
      let c = await repo.claim(T0, 300, LIMITS);
      await repo.transition(
        d1.id,
        { status: 'waiting', sinkJobId: 'job-1', runAfter: at(30) },
        T0,
        c!.claimId,
      );
      const d2 = delivery('one');
      await repo.create(pkg(), [d2], at(1));
      // d2 is due first, but d1 holds the only lane while it waits ...
      expect(await repo.claim(at(1), 300, LIMITS)).toBeNull();
      // ... and is polled when its time comes, whatever the lane holds.
      c = await repo.claim(at(30), 300, LIMITS);
      expect(c?.id).toBe(d1.id);
      // While it is polled (running), the queued one still waits.
      expect(await repo.claim(at(30), 300, LIMITS)).toBeNull();
      await repo.transition(
        d1.id,
        { status: 'waiting', sinkJobId: 'job-1', runAfter: at(60) },
        at(30),
        c!.claimId,
      );
      expect(await repo.claim(at(31), 300, LIMITS)).toBeNull();
      c = await repo.claim(at(60), 300, LIMITS);
      expect(c?.id).toBe(d1.id);
      await repo.transition(
        d1.id,
        { status: 'succeeded', receipt: { written: [] } },
        at(60),
        c!.claimId,
      );
      expect((await repo.claim(at(61), 300, LIMITS))?.id).toBe(d2.id);
    });

    it('an expired lease is claimed again though its lane is full', async () => {
      const repo = await make();
      await repo.create(pkg(), [delivery('one'), delivery('one')], T0);
      const first = await repo.claim(T0, 300, LIMITS);
      expect((await repo.claim(at(301), 300, LIMITS))?.id).toBe(first?.id);
      expect(await repo.claim(at(301), 300, LIMITS)).toBeNull();
    });

    it('built-in sinks are never limited', async () => {
      const repo = await make();
      await repo.create(
        pkg(),
        Array.from({ length: 3 }, () => delivery('files')),
        T0,
      );
      for (let n = 0; n < 3; n++) expect(await repo.claim(T0, 300, LIMITS)).not.toBeNull();
      expect(await repo.claim(T0, 300, LIMITS)).toBeNull();
    });
  });
}
