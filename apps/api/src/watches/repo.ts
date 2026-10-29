import { randomUUID } from 'node:crypto';
import {
  healthOf,
  WATCH_LOCKED_SETTINGS,
  type WatchEvent,
  type WatchPatchBody,
  type WatchRunAs,
  type WatchSettings,
  type WatchState,
  type WatchView,
} from '@ih/shared';
import { RUNNING_OUTCOMES } from '../conversions/repo.js';

export interface UnfinishedItem {
  itemId: string;
  jobId: string | null;
  outcome: string;
}

export type CreateWatchResult =
  { ok: true; watch: WatchView } | { ok: false; reason: 'name_taken' | 'unknown_target' };

/** `running`: the folder, target or run-as user changes only while stopped. */
export type UpdateWatchResult =
  | { ok: true; watch: WatchView }
  | { ok: false; reason: 'missing' | 'running' | 'name_taken' | 'unknown_target' | 'state' };

export type RemoveWatchResult = 'removed' | 'missing' | 'not_stopped';

/** A patch to a watch: the settings, with the run-as user and folder path that go with a folder. */
export interface WatchUpdate {
  settings: WatchPatchBody;
  runAs?: WatchRunAs;
  sourcePath?: string;
}

/**
 * Watched folders (migration 202610291400): `PgWatchRepo` / `MemoryWatchRepo`, held in step by
 * `test/watch-contract.ts`. The worker owns the pickups, finishes and the look schedule; the API
 * reads them through the view.
 */
export interface WatchRepo {
  list(): Promise<WatchView[]>;
  get(id: string): Promise<WatchView | null>;
  /** A new watch, stopped. */
  create(
    settings: WatchSettings,
    runAs: WatchRunAs,
    sourcePath: string,
    createdBy: WatchRunAs,
  ): Promise<CreateWatchResult>;
  /** `expectState`: refused with `state` unless the watch is in it. */
  update(id: string, patch: WatchUpdate, expectState?: WatchState): Promise<UpdateWatchResult>;
  setState(id: string, state: WatchState): Promise<WatchView | null>;
  /** Refused unless stopped. */
  remove(id: string): Promise<RemoveWatchResult>;
  /** Newest first. */
  events(id: string, limit?: number): Promise<WatchEvent[]>;
  /** Items of the watch's batch that have not reached a final outcome. */
  unfinishedItems(id: string): Promise<UnfinishedItem[]>;
  /** Watches that are running or draining with a problem. */
  problemCount(): Promise<number>;
}

/** What a memory watch keeps besides its view; tests set the worker-owned parts. */
interface Held {
  view: WatchView;
  items: UnfinishedItem[];
  finishes: { at: Date; delivered: boolean }[];
  events: WatchEvent[];
}

const DAY_MS = 24 * 3_600_000;

export class MemoryWatchRepo implements WatchRepo {
  private readonly held = new Map<string, Held>();
  private eventId = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private unfinished(h: Held): UnfinishedItem[] {
    return h.items.filter((i) => (RUNNING_OUTCOMES as readonly string[]).includes(i.outcome));
  }

  private view(h: Held): WatchView {
    const since = this.now().getTime() - DAY_MS;
    const day = h.finishes.filter((f) => f.at.getTime() >= since);
    const v = h.view;
    return {
      ...v,
      source: { ...v.source },
      health: healthOf(v),
      queue: { waiting: v.queue.waiting, inProgress: this.unfinished(h).length },
      throughput: {
        day: {
          delivered: day.filter((f) => f.delivered).length,
          failed: day.filter((f) => !f.delivered).length,
        },
        total: { ...v.throughput.total },
      },
    };
  }

  async list() {
    return [...this.held.values()]
      .map((h) => this.view(h))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string) {
    const h = this.held.get(id);
    return h ? this.view(h) : null;
  }

  private nameTaken(name: string, except?: string): boolean {
    const n = name.toLowerCase();
    return [...this.held.values()].some(
      (h) => h.view.id !== except && h.view.name.toLowerCase() === n,
    );
  }

  async create(
    settings: WatchSettings,
    runAs: WatchRunAs,
    sourcePath: string,
    _createdBy: WatchRunAs,
  ): Promise<CreateWatchResult> {
    if (this.nameTaken(settings.name)) return { ok: false, reason: 'name_taken' };
    const id = randomUUID();
    const view: WatchView = {
      ...settings,
      source: { ...settings.source },
      id,
      state: 'stopped',
      health: 'stopped',
      problem: null,
      sourcePath,
      runAs,
      queue: { waiting: 0, inProgress: 0 },
      throughput: { day: { delivered: 0, failed: 0 }, total: { delivered: 0, failed: 0 } },
      lastPickupAt: null,
      batchId: null,
      createdAt: this.now().toISOString(),
    };
    const h: Held = { view, items: [], finishes: [], events: [] };
    this.held.set(id, h);
    return { ok: true, watch: this.view(h) };
  }

  async update(
    id: string,
    patch: WatchUpdate,
    expectState?: WatchState,
  ): Promise<UpdateWatchResult> {
    const h = this.held.get(id);
    if (!h) return { ok: false, reason: 'missing' };
    if (expectState && h.view.state !== expectState) return { ok: false, reason: 'state' };
    const locked =
      patch.runAs !== undefined ||
      patch.sourcePath !== undefined ||
      WATCH_LOCKED_SETTINGS.some((k) => patch.settings[k] !== undefined);
    if (locked && h.view.state !== 'stopped') return { ok: false, reason: 'running' };
    if (patch.settings.name !== undefined && this.nameTaken(patch.settings.name, id)) {
      return { ok: false, reason: 'name_taken' };
    }
    h.view = {
      ...h.view,
      ...patch.settings,
      ...(patch.runAs ? { runAs: patch.runAs } : {}),
      ...(patch.sourcePath !== undefined ? { sourcePath: patch.sourcePath } : {}),
    };
    return { ok: true, watch: this.view(h) };
  }

  async setState(id: string, state: WatchState) {
    const h = this.held.get(id);
    if (!h) return null;
    h.view = { ...h.view, state };
    return this.view(h);
  }

  async remove(id: string): Promise<RemoveWatchResult> {
    const h = this.held.get(id);
    if (!h) return 'missing';
    if (h.view.state !== 'stopped') return 'not_stopped';
    this.held.delete(id);
    return 'removed';
  }

  async events(id: string, limit = 100) {
    return [...(this.held.get(id)?.events ?? [])].reverse().slice(0, limit);
  }

  async unfinishedItems(id: string) {
    const h = this.held.get(id);
    return h ? this.unfinished(h) : [];
  }

  async problemCount() {
    return [...this.held.values()].filter((h) => healthOf(h.view) === 'problem').length;
  }

  // Test hooks: the worker writes these in production.
  setProblem(id: string, problem: string | null): void {
    const h = this.held.get(id)!;
    h.view = { ...h.view, problem };
  }
  setWaiting(id: string, waiting: number): void {
    const h = this.held.get(id)!;
    h.view = { ...h.view, queue: { ...h.view.queue, waiting } };
  }
  addUnfinished(id: string, outcome: string): void {
    this.held.get(id)!.items.push({ itemId: randomUUID(), jobId: randomUUID(), outcome });
  }
  recordFinish(id: string, delivered: boolean, at: Date = this.now()): void {
    const h = this.held.get(id)!;
    h.finishes.push({ at, delivered });
    const t = h.view.throughput.total;
    h.view = {
      ...h.view,
      throughput: {
        ...h.view.throughput,
        total: {
          delivered: t.delivered + (delivered ? 1 : 0),
          failed: t.failed + (delivered ? 0 : 1),
        },
      },
    };
  }
  addEvent(id: string, level: WatchEvent['level'], message: string): void {
    this.held
      .get(id)!
      .events.push({
        id: ++this.eventId,
        at: this.now().toISOString(),
        level,
        message,
        details: null,
      });
  }
}
