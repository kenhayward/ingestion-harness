import { randomUUID } from 'node:crypto';
import {
  healthOf,
  WATCH_CANCELLED_DETAIL,
  WATCH_LOCKED_SETTINGS,
  type WatchEvent,
  type WatchPatchBody,
  type StopBody,
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

/** An item Stop now cancelled: the caller deletes its held files. Stop now also lets go of the
 * files the worker took but had not queued (`dropped`: their stored copies, for the caller to
 * delete): a file moved to `processing` stays there, never taken again; one still in the root is
 * picked up afresh after Start. */
export interface CancelledItem {
  itemId: string;
  batchId: string;
}

/** `state`: the watch is not in a state the stop applies to (drain: running; now: running or draining). */
export type StopResult =
  | { ok: true; watch: WatchView; cancelled: CancelledItem[]; dropped: string[] }
  | { ok: false; reason: 'missing' | 'state' };

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
  /** Running, its problem cleared, to be looked at at once. Null for an unknown watch. */
  start(id: string): Promise<WatchView | null>;
  /**
   * Stops pickups. `drain`: only a running watch, which shows *Draining* until its last item
   * finishes. `now`: a running or draining watch becomes stopped at once, and the items that
   * have not reached the bridge (`queued`, `decomposing`, `waiting_to_deliver`,
   * `awaiting_review`) are cancelled in the same transaction. An item no worker holds is
   * `failed` with `WATCH_CANCELLED_DETAIL`, counted as a failed finish, its pickup `abandoned`,
   * and returned in `cancelled`. An item whose job is running only has the job cancelled: the
   * worker fails it when it notices, or delivers it if it was past its last check, so a
   * document the bridge accepted is never recorded as cancelled. Items `delivering` finish on
   * their own and are not moved.
   */
  stop(id: string, mode: StopBody['mode']): Promise<StopResult>;
  /** How many watches name the target (it is locked while any does). */
  countForTarget(targetId: string): Promise<number>;
  /** Refused unless stopped. */
  remove(id: string): Promise<RemoveWatchResult>;
  /** Newest first. */
  events(id: string, limit?: number): Promise<WatchEvent[]>;
  /** Items of the watch's batch that have not reached a final outcome. */
  unfinishedItems(id: string): Promise<UnfinishedItem[]>;
  /** Watches that are running or draining with a problem. */
  problemCount(): Promise<number>;
}

/** An item of a memory watch's batch, with what Stop now changes. */
interface HeldItem extends UnfinishedItem {
  batchId: string;
  detail: string | null;
  /** The job's status; Stop now cancels a `queued` or `running` one. */
  jobStatus: 'queued' | 'running' | 'succeeded' | 'cancelled';
  pickup: 'queued' | 'abandoned';
}

/** What a memory watch keeps besides its view; tests set the worker-owned parts. */
interface Held {
  view: WatchView;
  items: HeldItem[];
  finishes: { at: Date; delivered: boolean }[];
  pickups: { step: string; moveFailures: number; objectKey?: string }[];
  events: WatchEvent[];
}

const DAY_MS = 24 * 3_600_000;

/** The unfinished outcomes whose item has not reached the bridge (Stop now cancels them). */
export const NOT_AT_BRIDGE = ['queued', 'decomposing', 'waiting_to_deliver', 'awaiting_review'];

export class MemoryWatchRepo implements WatchRepo {
  private readonly held = new Map<string, Held>();
  private eventId = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private unfinished(h: Held): HeldItem[] {
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
    const h: Held = { view, items: [], finishes: [], pickups: [], events: [] };
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

  async start(id: string) {
    const h = this.held.get(id);
    if (!h) return null;
    h.view = { ...h.view, state: 'running', problem: null };
    // Moves the sink refused are tried again (a pickup that ended keeps its count).
    for (const p of h.pickups) {
      if (p.step !== 'finished' && p.step !== 'abandoned') p.moveFailures = 0;
    }
    return this.view(h);
  }

  async stop(id: string, mode: StopBody['mode']): Promise<StopResult> {
    const h = this.held.get(id);
    if (!h) return { ok: false, reason: 'missing' };
    const state = h.view.state;
    if (mode === 'drain' ? state !== 'running' : state === 'stopped') {
      return { ok: false, reason: 'state' };
    }
    if (mode === 'drain') {
      h.view = { ...h.view, state: 'draining' };
      return { ok: true, watch: this.view(h), cancelled: [], dropped: [] };
    }
    h.view = { ...h.view, state: 'stopped' };
    const dropped: string[] = [];
    for (const p of h.pickups) {
      if (p.step !== 'stored' && p.step !== 'moved') continue;
      p.step = 'abandoned';
      if (p.objectKey) dropped.push(p.objectKey);
    }
    const cancelled: CancelledItem[] = [];
    for (const i of this.unfinished(h).filter((x) => NOT_AT_BRIDGE.includes(x.outcome))) {
      if (i.jobStatus === 'running') {
        // A worker holds it, and may be past its last cancel check: only the job is cancelled,
        // and the worker decides the item (it fails it when it notices).
        i.jobStatus = 'cancelled';
        continue;
      }
      if (i.jobStatus === 'queued') i.jobStatus = 'cancelled';
      i.outcome = 'failed';
      i.detail = WATCH_CANCELLED_DETAIL;
      i.pickup = 'abandoned';
      this.recordFinish(id, false);
      cancelled.push({ itemId: i.itemId, batchId: i.batchId });
    }
    return { ok: true, watch: this.view(h), cancelled, dropped };
  }

  async countForTarget(targetId: string) {
    return [...this.held.values()].filter((h) => h.view.targetId === targetId).length;
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
    return h
      ? this.unfinished(h).map(({ itemId, jobId, outcome }) => ({ itemId, jobId, outcome }))
      : [];
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
  addUnfinished(id: string, outcome: string, jobStatus?: string): string {
    const itemId = randomUUID();
    this.held.get(id)!.items.push({
      itemId,
      jobId: randomUUID(),
      outcome,
      batchId: `batch-of-${id}`,
      detail: null,
      jobStatus: (jobStatus ??
        (outcome === 'queued'
          ? 'queued'
          : outcome === 'decomposing'
            ? 'running'
            : 'succeeded')) as HeldItem['jobStatus'],
      pickup: 'queued',
    });
    return itemId;
  }
  /** What Stop now left of an item (a test reads it). */
  item(
    id: string,
    itemId: string,
  ): Pick<HeldItem, 'outcome' | 'detail' | 'jobStatus' | 'pickup' | 'batchId'> {
    const i = this.held.get(id)!.items.find((x) => x.itemId === itemId)!;
    return {
      outcome: i.outcome,
      detail: i.detail,
      jobStatus: i.jobStatus,
      pickup: i.pickup,
      batchId: i.batchId,
    };
  }
  /** A pickup the sink refused to move `moveFailures` times (the worker writes these). */
  addPickup(id: string, step: string, moveFailures: number, objectKey?: string): void {
    this.held.get(id)!.pickups.push({ step, moveFailures, objectKey });
  }
  /** The steps of the watch's pickups (with those of its items), sorted. */
  pickupSteps(id: string): string[] {
    const h = this.held.get(id)!;
    return [...h.pickups.map((p) => p.step), ...h.items.map((i) => i.pickup)].sort();
  }
  /** The pickups' refused-move counts, by step. */
  moveFailures(id: string): Record<string, number> {
    return Object.fromEntries(this.held.get(id)!.pickups.map((p) => [p.step, p.moveFailures]));
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
    this.held.get(id)!.events.push({
      id: ++this.eventId,
      at: this.now().toISOString(),
      level,
      message,
      details: null,
    });
  }
}
