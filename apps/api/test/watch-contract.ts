import type { WatchSettings } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import type { WatchRepo } from '../src/watches/repo.js';

/** What a test needs from an implementation: the parts the worker writes in production. */
export interface WatchHooks {
  setProblem(id: string, problem: string | null): Promise<void>;
  setWaiting(id: string, waiting: number): Promise<void>;
  addUnfinished(id: string, outcome: string): Promise<void>;
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
  });
}
