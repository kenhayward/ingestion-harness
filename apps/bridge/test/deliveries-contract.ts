import { randomUUID } from 'node:crypto';
import { bridgeError, type ActingUser } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import type { DeliveryRepo, NewPackage } from '../src/deliveries/repo.js';

const T0 = new Date('2026-10-19T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const KEY = 'c'.repeat(64);
const user: ActingUser = { id: 'u1', name: 'Pat', email: null };

export const pkg = (over: Partial<NewPackage> = {}): NewPackage => ({
  id: randomUUID(),
  kind: 'document',
  idempotencyKey: KEY,
  manifest: { kind: 'document' },
  stagedKey: 'packages/x.json',
  expiresAt: null,
  ...over,
});

export const delivery = (targetId = 't1') => ({
  id: randomUUID(),
  targetId,
  actingUser: user,
  overrides: {},
});

/** The behaviour every DeliveryRepo shares; `make` gives an empty repo whose targets t1, t2 exist. */
export function deliveriesContract(name: string, make: () => Promise<DeliveryRepo>): void {
  describe(`DeliveryRepo (${name})`, () => {
    it('create writes queued deliveries and one event each, sequence 1', async () => {
      const repo = await make();
      const d1 = delivery('t1');
      const d2 = delivery('t2');
      await repo.create(pkg(), [d1, d2], T0);
      const row = await repo.get(d1.id);
      expect(row).toMatchObject({
        status: 'queued',
        attempts: 0,
        targetId: 't1',
        actingUser: user,
      });
      expect(row?.idempotencyKey).toBe(KEY);
      const events = await repo.dueEvents(T0, 10);
      expect(events.map((e) => [e.body.deliveryId, e.body.sequence, e.body.status]).sort()).toEqual(
        [
          [d1.id, 1, 'queued'],
          [d2.id, 1, 'queued'],
        ].sort(),
      );
    });

    it('claim takes the oldest due delivery and leases it', async () => {
      const repo = await make();
      const early = delivery();
      const late = delivery();
      await repo.create(pkg(), [early], T0);
      await repo.create(pkg(), [late], at(1));
      const claimed = await repo.claim(at(2), 300);
      expect(claimed).toMatchObject({ id: early.id, status: 'running', attempts: 1 });
      expect((await repo.claim(at(2), 300))?.id).toBe(late.id);
      expect(await repo.claim(at(2), 300)).toBeNull();
    });

    it('claim waits for run_after', async () => {
      const repo = await make();
      const d = delivery();
      await repo.create(pkg(), [d], T0);
      const c = await repo.claim(T0, 300);
      const error = bridgeError('timeout', 'slow');
      await repo.transition(d.id, { status: 'queued', runAfter: at(60), error }, T0, c!.claimId);
      expect(await repo.claim(at(59), 300)).toBeNull();
      expect((await repo.claim(at(60), 300))?.id).toBe(d.id);
    });

    it('claim skips a delivery leased by someone else', async () => {
      const repo = await make();
      await repo.create(pkg(), [delivery()], T0);
      expect(await repo.claim(T0, 300)).not.toBeNull();
      expect(await repo.claim(at(299), 300)).toBeNull();
    });

    it('reclaims an expired lease', async () => {
      const repo = await make();
      const d = delivery();
      await repo.create(pkg(), [d], T0);
      await repo.claim(T0, 300);
      const again = await repo.claim(at(301), 300);
      expect(again).toMatchObject({ id: d.id, status: 'running', attempts: 2 });
    });

    it('refuses a late transition from a claim whose lease was taken over', async () => {
      const repo = await make();
      const d = delivery();
      await repo.create(pkg(), [d], T0);
      const slow = await repo.claim(T0, 300);
      const takeover = await repo.claim(at(301), 300);
      expect(takeover?.claimId).not.toBe(slow?.claimId);
      const receipt = { written: [] };
      expect(
        await repo.transition(d.id, { status: 'succeeded', receipt }, at(400), slow!.claimId),
      ).toBe(false);
      expect(await repo.get(d.id)).toMatchObject({ status: 'running', attempts: 2 });
      expect(
        await repo.transition(d.id, { status: 'succeeded', receipt }, at(401), takeover!.claimId),
      ).toBe(true);
      expect((await repo.get(d.id))?.status).toBe('succeeded');
    });

    it('claiming a waiting delivery to poll it does not count as an attempt', async () => {
      const repo = await make();
      const d = delivery();
      await repo.create(pkg(), [d], T0);
      const c = await repo.claim(T0, 300);
      await repo.transition(
        d.id,
        { status: 'waiting', sinkJobId: 'job-1', runAfter: at(30) },
        T0,
        c!.claimId,
      );
      expect(await repo.claim(at(30), 300)).toMatchObject({
        status: 'running',
        attempts: 1,
        sinkJobId: 'job-1',
      });
    });

    it('a retry clears the sink job, so the next attempt delivers afresh', async () => {
      const repo = await make();
      const d = delivery();
      await repo.create(pkg(), [d], T0);
      let c = await repo.claim(T0, 300);
      await repo.transition(
        d.id,
        { status: 'waiting', sinkJobId: 'job-1', runAfter: at(30) },
        T0,
        c!.claimId,
      );
      c = await repo.claim(at(30), 300);
      const error = bridgeError('instance_unavailable', 'down');
      await repo.transition(
        d.id,
        { status: 'queued', runAfter: at(60), error },
        at(30),
        c!.claimId,
      );
      expect(await repo.get(d.id)).toMatchObject({ status: 'queued', sinkJobId: null });
    });

    it('a retry requeues with run_after and keeps the error', async () => {
      const repo = await make();
      const d = delivery();
      await repo.create(pkg(), [d], T0);
      const c = await repo.claim(T0, 300);
      const error = bridgeError('timeout', 'slow');
      await repo.transition(d.id, { status: 'queued', runAfter: at(30), error }, T0, c!.claimId);
      expect(await repo.get(d.id)).toMatchObject({ status: 'queued', runAfter: at(30), error });
    });

    it('transition writes the next event with sequence+1', async () => {
      const repo = await make();
      const d = delivery();
      await repo.create(pkg(), [d], T0);
      const c = await repo.claim(T0, 300);
      const receipt = { written: [{ kind: 'object', id: 'k', label: null, url: null }] };
      await repo.transition(d.id, { status: 'succeeded', receipt }, at(1), c!.claimId);
      expect(await repo.get(d.id)).toMatchObject({ status: 'succeeded', receipt });
      const events = await repo.dueEvents(at(1), 10);
      expect(events.map((e) => [e.body.sequence, e.body.status, e.body.receipt])).toEqual([
        [1, 'queued', null],
        [2, 'succeeded', receipt],
      ]);
    });

    it('a waiting delivery is claimable again once its poll is due', async () => {
      const repo = await make();
      const d = delivery();
      await repo.create(pkg(), [d], T0);
      const c = await repo.claim(T0, 300);
      await repo.transition(
        d.id,
        { status: 'waiting', sinkJobId: 'job-9', runAfter: at(30) },
        T0,
        c!.claimId,
      );
      expect(await repo.claim(at(29), 300)).toBeNull();
      expect(await repo.claim(at(30), 300)).toMatchObject({ id: d.id, sinkJobId: 'job-9' });
    });

    it('latestSucceeded finds the newest success for target and key, excluding the asker', async () => {
      const repo = await make();
      const [first, second, asking, other] = [delivery(), delivery(), delivery(), delivery('t2')];
      const receipt = { written: [] };
      for (const [i, d] of [first, second, asking, other].entries()) {
        await repo.create(pkg(), [d], at(i));
      }
      for (const [i, d] of [first, second, other].entries()) {
        let c = await repo.claim(at(10), 300);
        while (c && c.id !== d.id) c = await repo.claim(at(10), 300);
        await repo.transition(d.id, { status: 'succeeded', receipt }, at(20 + i), c!.claimId);
      }
      expect((await repo.latestSucceeded('t1', KEY, asking.id))?.id).toBe(second.id);
      expect((await repo.latestSucceeded('t1', KEY, second.id))?.id).toBe(first.id);
      expect(await repo.latestSucceeded('t1', 'd'.repeat(64), asking.id)).toBeNull();
    });

    it('marks events sent and retries failed ones later', async () => {
      const repo = await make();
      await repo.create(pkg(), [delivery(), delivery()], T0);
      const [a, b] = await repo.dueEvents(T0, 10);
      await repo.markSent(a!.id, T0);
      await repo.retryEvent(b!.id, at(60));
      expect(await repo.dueEvents(at(59), 10)).toEqual([]);
      const due = await repo.dueEvents(at(60), 10);
      expect(due.map((e) => [e.id, e.attempts])).toEqual([[b!.id, 1]]);
    });

    it('reads a package back', async () => {
      const repo = await make();
      const p = pkg();
      await repo.create(p, [delivery()], T0);
      expect(await repo.getPackage(p.id)).toMatchObject({ id: p.id, stagedKey: p.stagedKey });
    });

    it('usesTarget says whether an unfinished delivery names the target', async () => {
      const repo = await make();
      expect(await repo.usesTarget('t1')).toBe(false);
      await repo.create(pkg(), [delivery('t1')], T0);
      expect(await repo.usesTarget('t1')).toBe(true);
      expect(await repo.usesTarget('t2')).toBe(false);
      const claimed = (await repo.claim(at(1), 300))!;
      expect(await repo.usesTarget('t1')).toBe(true);
      await repo.transition(
        claimed.id,
        { status: 'succeeded', receipt: { written: [] } },
        at(2),
        claimed.claimId,
      );
      expect(await repo.usesTarget('t1')).toBe(false);
    });

    it('lists packages past their retention whose deliveries are all final, until pruned', async () => {
      const repo = await make();
      const done = pkg({ stagedKey: 'packages/done.json', expiresAt: at(100) });
      const busy = pkg({ stagedKey: 'packages/busy.json', expiresAt: at(100) });
      const young = pkg({ stagedKey: 'packages/young.json', expiresAt: at(1000) });
      const kept = pkg({ stagedKey: 'packages/kept.json', expiresAt: null });
      const ids = [delivery(), delivery(), delivery(), delivery()];
      await repo.create(done, [ids[0]!], T0);
      await repo.create(busy, [ids[1]!], at(1));
      await repo.create(young, [ids[2]!], at(2));
      await repo.create(kept, [ids[3]!], at(3));
      const claims = [];
      for (let n = 0; n < 4; n++) claims.push((await repo.claim(at(10), 300))!);
      expect(claims.map((c) => c.id)).toEqual(ids.map((d) => d.id));
      const final = { status: 'failed' as const, error: bridgeError('timeout', 'x') };
      await repo.transition(
        ids[0]!.id,
        { status: 'succeeded', receipt: { written: [] } },
        at(11),
        claims[0]!.claimId,
      );
      // `busy` stays running; `young` and `kept` end, but are not past their retention.
      await repo.transition(ids[2]!.id, final, at(11), claims[2]!.claimId);
      await repo.transition(ids[3]!.id, final, at(11), claims[3]!.claimId);
      expect(await repo.expiredPackages(at(200), 10)).toEqual([
        { id: done.id, stagedKey: 'packages/done.json' },
      ]);
      await repo.markPruned(done.id, at(200));
      expect(await repo.expiredPackages(at(200), 10)).toEqual([]);
    });
  });
}
