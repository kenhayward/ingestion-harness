import { randomUUID } from 'node:crypto';
import type {
  ActingUser,
  BridgeError,
  BridgeEvent,
  DeliveryStatus,
  Receipt,
} from '@ih/bridge-contract';

export interface NewPackage {
  id: string;
  kind: 'document' | 'graph';
  idempotencyKey: string;
  /** The package without file and image bytes. */
  manifest: unknown;
  stagedKey: string;
  expiresAt: Date | null;
}

export interface NewDelivery {
  id: string;
  targetId: string;
  actingUser: ActingUser | null;
  overrides: Record<string, string>;
}

export interface DeliveryRow {
  id: string;
  packageId: string;
  targetId: string;
  idempotencyKey: string;
  actingUser: ActingUser | null;
  overrides: Record<string, string>;
  status: DeliveryStatus;
  attempts: number;
  runAfter: Date;
  sinkJobId: string | null;
  error: BridgeError | null;
  receipt: Receipt | null;
  skippedFor: string | null;
  /** Who holds the current claim; a transition must present it (fencing against late runners). */
  claimId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A row as a claim returns it: always with the claim's id. */
export type ClaimedRow = DeliveryRow & { claimId: string };

/** A status change the runner records; `queued` with an error is a retry. */
export type Transition =
  | { status: 'succeeded'; receipt: Receipt }
  | { status: 'waiting'; sinkJobId: string; runAfter: Date }
  | { status: 'skipped'; skippedFor: string }
  | { status: 'needs_user' | 'failed'; error: BridgeError }
  | { status: 'queued'; runAfter: Date; error: BridgeError };

export interface OutboxEvent {
  id: string;
  body: BridgeEvent;
  attempts: number;
}

/** Packages, deliveries and the event outbox. */
export interface DeliveryRepo {
  /** One transaction: the package, its deliveries ('queued') and a 'queued' event each. */
  create(pkg: NewPackage, deliveries: NewDelivery[], now: Date): Promise<void>;
  /**
   * Claims one due delivery ('queued' or 'waiting' with run_after <= now, or 'running' whose lease
   * has expired): status 'running', a fresh claimId, leased until now + leaseSeconds. Attempts
   * count deliveries: + 1, except when claiming a 'waiting' delivery to poll its sink job.
   */
  claim(now: Date, leaseSeconds: number): Promise<ClaimedRow | null>;
  /**
   * One transaction: the status change, the lease cleared, the next event in the outbox. Only
   * for the current claim: false (and nothing written) when the delivery is no longer running
   * under `claimId`, e.g. its lease expired and another runner took it over.
   */
  transition(id: string, t: Transition, now: Date, claimId: string): Promise<boolean>;
  get(id: string): Promise<DeliveryRow | null>;
  /** The newest 'succeeded' delivery of this key to this target, other than `exceptId`. */
  latestSucceeded(
    targetId: string,
    idempotencyKey: string,
    exceptId: string,
  ): Promise<DeliveryRow | null>;
  getPackage(id: string): Promise<NewPackage | null>;
  /** Whether any delivery names this target (which then cannot be removed). */
  usesTarget(targetId: string): Promise<boolean>;
  /** Packages past `expiresAt` (at `now`), not pruned, whose deliveries are all final. */
  expiredPackages(now: Date, limit: number): Promise<{ id: string; stagedKey: string }[]>;
  /** The package's staged bytes are gone. */
  markPruned(id: string, now: Date): Promise<void>;
  /** Unsent events whose time has come, oldest first. */
  dueEvents(now: Date, limit: number): Promise<OutboxEvent[]>;
  markSent(eventId: string, now: Date): Promise<void>;
  retryEvent(eventId: string, runAfter: Date): Promise<void>;
}

/** The event a delivery's status change produces. */
export function eventFor(row: DeliveryRow, sequence: number, now: Date): BridgeEvent {
  return {
    eventId: randomUUID(),
    deliveryId: row.id,
    sequence,
    status: row.status,
    error: row.error,
    receipt: row.receipt,
    at: now.toISOString(),
  };
}

/** The row after transition `t`. */
export function applyTransition(row: DeliveryRow, t: Transition, now: Date): DeliveryRow {
  const next: DeliveryRow = { ...row, status: t.status, updatedAt: now };
  switch (t.status) {
    case 'succeeded':
      return { ...next, receipt: t.receipt, error: null };
    case 'waiting':
      return { ...next, sinkJobId: t.sinkJobId, runAfter: t.runAfter };
    case 'skipped':
      return { ...next, skippedFor: t.skippedFor };
    case 'needs_user':
    case 'failed':
      return { ...next, error: t.error };
    case 'queued':
      // A retry delivers afresh: a sink job that failed is not polled again.
      return { ...next, runAfter: t.runAfter, error: t.error, sinkJobId: null };
  }
}

interface MemoryDelivery extends DeliveryRow {
  leaseUntil: Date | null;
  order: number;
}

interface MemoryEvent extends OutboxEvent {
  runAfter: Date;
  sentAt: Date | null;
  order: number;
}

const strip = ({ leaseUntil: _l, order: _o, ...row }: MemoryDelivery): DeliveryRow => ({ ...row });

/** Statuses a delivery never leaves. */
export const FINAL_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'skipped',
  'needs_user',
  'failed',
]);

export class MemoryDeliveryRepo implements DeliveryRepo {
  private readonly packages = new Map<string, NewPackage>();
  private readonly deliveries = new Map<string, MemoryDelivery>();
  private readonly events: MemoryEvent[] = [];
  private order = 0;

  private emit(row: DeliveryRow, now: Date): void {
    const sequence = this.events.filter((e) => e.body.deliveryId === row.id).length + 1;
    const body = eventFor(row, sequence, now);
    this.events.push({
      id: body.eventId,
      body,
      attempts: 0,
      runAfter: now,
      sentAt: null,
      order: this.order++,
    });
  }

  async create(pkg: NewPackage, deliveries: NewDelivery[], now: Date): Promise<void> {
    this.packages.set(pkg.id, { ...pkg });
    for (const d of deliveries) {
      const row: MemoryDelivery = {
        ...d,
        packageId: pkg.id,
        idempotencyKey: pkg.idempotencyKey,
        status: 'queued',
        attempts: 0,
        runAfter: now,
        sinkJobId: null,
        error: null,
        receipt: null,
        skippedFor: null,
        claimId: null,
        createdAt: now,
        updatedAt: now,
        leaseUntil: null,
        order: this.order++,
      };
      this.deliveries.set(d.id, row);
      this.emit(row, now);
    }
  }

  async claim(now: Date, leaseSeconds: number): Promise<ClaimedRow | null> {
    const due = [...this.deliveries.values()]
      .filter(
        (d) =>
          ((d.status === 'queued' || d.status === 'waiting') && d.runAfter <= now) ||
          (d.status === 'running' && d.leaseUntil !== null && d.leaseUntil < now),
      )
      .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime() || a.order - b.order);
    const row = due[0];
    if (!row) return null;
    if (row.status !== 'waiting') row.attempts += 1;
    row.status = 'running';
    row.claimId = randomUUID();
    row.leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
    row.updatedAt = now;
    return strip(row) as ClaimedRow;
  }

  async transition(id: string, t: Transition, now: Date, claimId: string): Promise<boolean> {
    const row = this.deliveries.get(id);
    if (!row || row.status !== 'running' || row.claimId !== claimId) return false;
    const next = {
      ...applyTransition(row, t, now),
      claimId: null,
      leaseUntil: null,
      order: row.order,
    };
    this.deliveries.set(id, next);
    this.emit(next, now);
    return true;
  }

  async get(id: string): Promise<DeliveryRow | null> {
    const row = this.deliveries.get(id);
    return row ? strip(row) : null;
  }

  async latestSucceeded(
    targetId: string,
    idempotencyKey: string,
    exceptId: string,
  ): Promise<DeliveryRow | null> {
    const found = [...this.deliveries.values()]
      .filter(
        (d) =>
          d.targetId === targetId &&
          d.idempotencyKey === idempotencyKey &&
          d.status === 'succeeded' &&
          d.id !== exceptId,
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    return found ? strip(found) : null;
  }

  async getPackage(id: string): Promise<NewPackage | null> {
    return this.packages.get(id) ?? null;
  }

  async usesTarget(targetId: string): Promise<boolean> {
    return [...this.deliveries.values()].some((d) => d.targetId === targetId);
  }

  private readonly pruned = new Set<string>();

  async expiredPackages(now: Date, limit: number): Promise<{ id: string; stagedKey: string }[]> {
    const deliveries = [...this.deliveries.values()];
    return [...this.packages.values()]
      .filter(
        (p) =>
          p.expiresAt !== null &&
          p.expiresAt <= now &&
          !this.pruned.has(p.id) &&
          deliveries.every((d) => d.packageId !== p.id || FINAL_STATUSES.has(d.status)),
      )
      .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())
      .slice(0, limit)
      .map((p) => ({ id: p.id, stagedKey: p.stagedKey }));
  }

  async markPruned(id: string): Promise<void> {
    this.pruned.add(id);
  }

  async dueEvents(now: Date, limit: number): Promise<OutboxEvent[]> {
    return this.events
      .filter((e) => e.sentAt === null && e.runAfter <= now)
      .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime() || a.order - b.order)
      .slice(0, limit)
      .map(({ id, body, attempts }) => ({ id, body, attempts }));
  }

  async markSent(eventId: string, now: Date): Promise<void> {
    const e = this.events.find((x) => x.id === eventId);
    if (e) e.sentAt = now;
  }

  async retryEvent(eventId: string, runAfter: Date): Promise<void> {
    const e = this.events.find((x) => x.id === eventId);
    if (e) {
      e.attempts += 1;
      e.runAfter = runAfter;
    }
  }
}
