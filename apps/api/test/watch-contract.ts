import type { WatchSettings } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import type { WatchRepo } from '../src/watches/repo.js';

/** What a test needs from an implementation: the parts the worker writes in production. */
export interface WatchHooks {
  setProblem(id: string, problem: string | null): Promise<void>;
  setWaiting(id: string, waiting: number): Promise<void>;
  /** An item of the watch's batch at `outcome`, with its job and pickup as the worker leaves them; its id. */
  addUnfinished(id: string, outcome: string, jobStatus?: string): Promise<string>;
  /** What is stored of an item: its outcome and detail, its job's status and its pickup's step. */
  inspect(
    id: string,
    itemId: string,
  ): Promise<{ outcome: string; detail: string | null; jobStatus: string; pickup: string }>;
  /** A pickup of the watch at `step` that the sink refused to move `moveFailures` times. */
  addPickup(id: string, step: string, moveFailures: number): Promise<void>;
  /** The pickups' refused-move counts, by step. */
  moveFailures(id: string): Promise<Record<string, number>>;
  /** A final outcome `hoursAgo` hours ago. */
  recordFinish(id: string, delivered: boolean, hoursAgo: number): Promise<void>;
  addEvent(id: string, level: 'info' | 'warn' | 'error', message: string): Promise<void>;
}
export type MakeWatches = () => Promise<{ repo: WatchRepo; hooks: WatchHooks; targetId: string }>;

const user = { id: 'u1', name: 'Ken', email: 'ken@example.com' };

export const settings = (targetId: string, over: Partial<WatchSettings> = {}): WatchSettings => ({
  name: 'Inbox',
  targetId,
  source: { folder: 'incoming' },
  force: false,
  autoApprove: true,
  reasonFiles: true,
  sleepSeconds: 30,
  admit: 10,
  ...over,
});

const MISSING = '00000000-0000-4000-8000-000000000000';

/** The WatchRepo contract (docs/superpowers/specs/2026-10-29-watched-folders-design.md). */
export function watchContract(name: string, make: MakeWatches) {
  describe(`${name}: watch repository contract`, () => {
    it('creates a stopped watch with its defaults and reads it back', async () => {
      const { repo, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      const w = made.watch;
      expect(w).toMatchObject({
        name: 'Inbox',
        targetId,
        source: { folder: 'incoming' },
        sourcePath: 'incoming',
        runAs: user,
        force: false,
        autoApprove: true,
        reasonFiles: true,
        sleepSeconds: 30,
        admit: 10,
        state: 'stopped',
        health: 'stopped',
        problem: null,
        queue: { waiting: 0, inProgress: 0 },
        throughput: { day: { delivered: 0, failed: 0 }, total: { delivered: 0, failed: 0 } },
        lastPickupAt: null,
        batchId: null,
      });
      expect(w.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(w.createdAt)).not.toBeNaN();
      expect(await repo.get(w.id)).toEqual(w);
      expect(await repo.list()).toEqual([w]);
      expect(await repo.get(MISSING)).toBeNull();
    });

    it('keeps names unique whatever the case', async () => {
      const { repo, targetId } = await make();
      await repo.create(settings(targetId), user, 'incoming', user);
      expect(await repo.create(settings(targetId, { name: 'inbox' }), user, 'x', user)).toEqual({
        ok: false,
        reason: 'name_taken',
      });
      const other = await repo.create(settings(targetId, { name: 'Other' }), user, 'x', user);
      expect(other.ok).toBe(true);
      if (!other.ok) return;
      expect(await repo.update(other.watch.id, { settings: { name: 'INBOX' } })).toEqual({
        ok: false,
        reason: 'name_taken',
      });
    });

    it('changes the tuning while running but not the folder, target or run-as user', async () => {
      const { repo, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      const id = made.watch.id;
      await repo.setState(id, 'running');
      const tuned = await repo.update(id, { settings: { admit: 20, sleepSeconds: 60 } });
      expect(tuned.ok && tuned.watch).toMatchObject({ admit: 20, sleepSeconds: 60 });
      expect(await repo.update(id, { settings: { targetId } })).toEqual({
        ok: false,
        reason: 'running',
      });
      expect(
        await repo.update(id, { settings: { source: { folder: 'b' } }, sourcePath: 'b' }),
      ).toEqual({ ok: false, reason: 'running' });
      expect(await repo.update(id, { settings: {}, runAs: { ...user, name: 'Other' } })).toEqual({
        ok: false,
        reason: 'running',
      });
      await repo.setState(id, 'stopped');
      const moved = await repo.update(id, {
        settings: { source: { folder: 'b' } },
        sourcePath: 'b',
        runAs: { ...user, name: 'Other' },
      });
      expect(moved.ok && moved.watch).toMatchObject({
        source: { folder: 'b' },
        sourcePath: 'b',
        runAs: { name: 'Other' },
      });
    });

    it('refuses an update that expects another state, and one for an unknown watch', async () => {
      const { repo, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      expect(await repo.update(made.watch.id, { settings: { admit: 5 } }, 'running')).toEqual({
        ok: false,
        reason: 'state',
      });
      expect(await repo.update(made.watch.id, { settings: { admit: 5 } }, 'stopped')).toMatchObject(
        { ok: true },
      );
      expect(await repo.update(MISSING, { settings: { admit: 5 } })).toEqual({
        ok: false,
        reason: 'missing',
      });
    });

    it('removes a stopped watch only', async () => {
      const { repo, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      const id = made.watch.id;
      await repo.setState(id, 'running');
      expect(await repo.remove(id)).toBe('not_stopped');
      await repo.setState(id, 'draining');
      expect(await repo.remove(id)).toBe('not_stopped');
      await repo.setState(id, 'stopped');
      expect(await repo.remove(id)).toBe('removed');
      expect(await repo.get(id)).toBeNull();
      expect(await repo.remove(id)).toBe('missing');
    });

    it('counts only the last 24 hours of finishes in the day figures', async () => {
      const { repo, hooks, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      const id = made.watch.id;
      await hooks.recordFinish(id, true, 1);
      await hooks.recordFinish(id, true, 23);
      await hooks.recordFinish(id, false, 2);
      await hooks.recordFinish(id, true, 30);
      await hooks.recordFinish(id, false, 72);
      const t = (await repo.get(id))!.throughput;
      expect(t.day).toEqual({ delivered: 2, failed: 1 });
      expect(t.total).toEqual({ delivered: 3, failed: 2 });
    });

    it('reports the root queue and the unfinished items', async () => {
      const { repo, hooks, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      const id = made.watch.id;
      await hooks.setWaiting(id, 4);
      await hooks.addUnfinished(id, 'decomposing');
      await hooks.addUnfinished(id, 'waiting_to_deliver');
      await hooks.addUnfinished(id, 'created');
      const w = (await repo.get(id))!;
      expect(w.queue).toEqual({ waiting: 4, inProgress: 2 });
      const items = await repo.unfinishedItems(id);
      expect(items.map((i) => i.outcome).sort()).toEqual(['decomposing', 'waiting_to_deliver']);
      for (const i of items) expect(i.itemId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('derives health from state and problem and counts watches with a problem', async () => {
      const { repo, hooks, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      const id = made.watch.id;
      await hooks.setProblem(id, 'the folder is gone');
      // A stopped watch is never a problem.
      expect((await repo.get(id))!.health).toBe('stopped');
      expect(await repo.problemCount()).toBe(0);
      await repo.setState(id, 'running');
      const w = (await repo.get(id))!;
      expect(w.health).toBe('problem');
      expect(w.problem).toBe('the folder is gone');
      expect(await repo.problemCount()).toBe(1);
      await repo.setState(id, 'draining');
      expect((await repo.get(id))!.health).toBe('problem');
      await hooks.setProblem(id, null);
      expect((await repo.get(id))!.health).toBe('draining');
      expect(await repo.problemCount()).toBe(0);
    });

    it('lists events newest first up to the limit', async () => {
      const { repo, hooks, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      const id = made.watch.id;
      expect(await repo.events(id)).toEqual([]);
      await hooks.addEvent(id, 'info', 'one');
      await hooks.addEvent(id, 'warn', 'two');
      await hooks.addEvent(id, 'error', 'three');
      expect((await repo.events(id)).map((e) => e.message)).toEqual(['three', 'two', 'one']);
      const two = await repo.events(id, 2);
      expect(two.map((e) => [e.level, e.message])).toEqual([
        ['error', 'three'],
        ['warn', 'two'],
      ]);
    });

    it('starts a watch: running, its problem cleared, stuck moves tried again', async () => {
      const { repo, hooks, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      const id = made.watch.id;
      await hooks.setProblem(id, 'the folder is gone');
      await hooks.addPickup(id, 'refusing', 5);
      await hooks.addPickup(id, 'moved', 2);
      await hooks.addPickup(id, 'finished', 3);
      await hooks.addPickup(id, 'abandoned', 4);
      await repo.setState(id, 'draining');
      const started = await repo.start(id);
      expect(started).toMatchObject({ state: 'running', problem: null, health: 'running' });
      // Pickups still to move try again; the ones that ended keep their count.
      expect(await hooks.moveFailures(id)).toEqual({
        refusing: 0,
        moved: 0,
        finished: 3,
        abandoned: 4,
      });
      expect(await repo.start(MISSING)).toBeNull();
    });

    it('drains a running watch only; stop now takes a running or draining one', async () => {
      const { repo, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      const id = made.watch.id;
      expect(await repo.stop(id, 'drain')).toEqual({ ok: false, reason: 'state' });
      expect(await repo.stop(id, 'now')).toEqual({ ok: false, reason: 'state' });
      await repo.start(id);
      const drained = await repo.stop(id, 'drain');
      expect(drained).toMatchObject({ ok: true, watch: { state: 'draining' }, cancelled: [] });
      expect(await repo.stop(id, 'drain')).toEqual({ ok: false, reason: 'state' });
      const now = await repo.stop(id, 'now');
      expect(now).toMatchObject({ ok: true, watch: { state: 'stopped' } });
      expect(await repo.stop(MISSING, 'now')).toEqual({ ok: false, reason: 'missing' });
    });

    it('stop now fails what no worker holds, cancels the job of what one runs, and leaves the rest', async () => {
      const { repo, hooks, targetId } = await make();
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      const id = made.watch.id;
      await repo.start(id);
      const ids: Record<string, string> = {
        queued: await hooks.addUnfinished(id, 'queued'),
        waiting: await hooks.addUnfinished(id, 'waiting_to_deliver'),
        review: await hooks.addUnfinished(id, 'awaiting_review'),
        // A worker holds these: it may be past its last cancel check, and is the one to decide.
        decomposing: await hooks.addUnfinished(id, 'decomposing'),
        waitingRunning: await hooks.addUnfinished(id, 'waiting_to_deliver', 'running'),
        delivering: await hooks.addUnfinished(id, 'delivering'),
        created: await hooks.addUnfinished(id, 'created'),
      };
      const done = await repo.stop(id, 'now');
      if (!done.ok) throw new Error('stop failed');
      expect(done.cancelled.map((c) => c.itemId).sort()).toEqual(
        [ids.queued!, ids.waiting!, ids.review!].sort(),
      );
      for (const key of ['queued', 'waiting', 'review']) {
        expect(await hooks.inspect(id, ids[key]!)).toMatchObject({
          outcome: 'failed',
          detail: 'Cancelled: the watch was stopped',
          pickup: 'abandoned',
        });
      }
      expect((await hooks.inspect(id, ids.queued!)).jobStatus).toBe('cancelled');
      expect((await hooks.inspect(id, ids.waiting!)).jobStatus).toBe('succeeded');
      // A running job is cancelled and its item left to the worker, which fails it when it
      // notices (or delivers it, if it was past the last check: nothing is written over that).
      for (const key of ['decomposing', 'waitingRunning']) {
        const seen = await hooks.inspect(id, ids[key]!);
        expect(seen).toMatchObject({ detail: null, jobStatus: 'cancelled', pickup: 'queued' });
      }
      expect((await hooks.inspect(id, ids.decomposing!)).outcome).toBe('decomposing');
      expect((await hooks.inspect(id, ids.waitingRunning!)).outcome).toBe('waiting_to_deliver');
      expect(await hooks.inspect(id, ids.delivering!)).toMatchObject({
        outcome: 'delivering',
        pickup: 'queued',
      });
      expect(await hooks.inspect(id, ids.created!)).toMatchObject({ outcome: 'created' });
      // Only the documents failed here count as failed now; the others count when they settle.
      const w = (await repo.get(id))!;
      expect(w.throughput.total).toEqual({ delivered: 0, failed: 3 });
      expect(w.throughput.day.failed).toBe(3);
      expect(w.queue.inProgress).toBe(3);
    });

    it('counts the watches that name a target', async () => {
      const { repo, targetId } = await make();
      expect(await repo.countForTarget(targetId)).toBe(0);
      const made = await repo.create(settings(targetId), user, 'incoming', user);
      if (!made.ok) throw new Error('create failed');
      expect(await repo.countForTarget(targetId)).toBe(1);
      expect(await repo.countForTarget('elsewhere')).toBe(0);
      await repo.remove(made.watch.id);
      expect(await repo.countForTarget(targetId)).toBe(0);
    });
  });
}
