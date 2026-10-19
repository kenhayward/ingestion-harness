import { bridgeError, type BridgeError, type SinkJobStatus } from '@ih/bridge-contract';
import type { PackageStore } from '../packages/store.js';
import { SinkError, type SinkPort, type SinkRegistry } from '../sinks/port.js';
import type { TargetRepo } from '../targets/repo.js';
import type { DeliveryRepo, DeliveryRow, Transition } from './repo.js';

export interface RunnerDeps {
  deliveries: DeliveryRepo;
  packages: PackageStore;
  targets: TargetRepo;
  sinks: SinkRegistry;
  maxAttempts: number;
  leaseSeconds: number;
  /** How long to wait before asking a sink about a pending job again. */
  pollSeconds?: number;
}

/** Seconds to wait before retry number `attempt`: 30 s, doubling, at most an hour. */
export const backoff = (attempt: number): number => Math.min(2 ** attempt * 15, 3600);

const later = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

/** A sink's failure in contract terms. */
function asBridgeError(err: unknown): BridgeError {
  if (err instanceof SinkError) return err.error;
  return bridgeError('internal', err instanceof Error ? err.message : String(err));
}

/** What a failure turns into: stop for a person, retry later, or give up. */
function onError(row: DeliveryRow, error: BridgeError, deps: RunnerDeps, now: Date): Transition {
  if (error.class === 'needs_user') return { status: 'needs_user', error };
  if (row.attempts >= deps.maxAttempts) return { status: 'failed', error };
  return { status: 'queued', runAfter: later(now, backoff(row.attempts)), error };
}

function fromJobStatus(
  s: SinkJobStatus,
  row: DeliveryRow,
  deps: RunnerDeps,
  now: Date,
): Transition {
  if (s.status === 'succeeded') return { status: 'succeeded', receipt: s.receipt };
  if (s.status === 'failed') return onError(row, s.error, deps, now);
  return {
    status: 'waiting',
    sinkJobId: row.sinkJobId!,
    runAfter: later(now, deps.pollSeconds ?? 30),
  };
}

async function step(row: DeliveryRow, deps: RunnerDeps, now: Date): Promise<Transition> {
  const target = await deps.targets.get(row.targetId);
  if (!target) {
    throw new SinkError(bridgeError('target_missing', `no target ${row.targetId}`));
  }
  const sink: SinkPort | null = deps.sinks.get(target.sinkId);
  if (!sink) {
    throw new SinkError(
      bridgeError('sink_unavailable', `the sink of ${target.label} is not available`),
    );
  }
  if (row.sinkJobId) {
    return fromJobStatus(await sink.deliveryStatus(row.sinkJobId), row, deps, now);
  }
  const { capabilities } = await sink.describe();
  if (!capabilities.replace && !capabilities.withdraw) {
    const earlier = await deps.deliveries.latestSucceeded(row.targetId, row.idempotencyKey, row.id);
    if (earlier) return { status: 'skipped', skippedFor: earlier.id };
  }
  const meta = await deps.deliveries.getPackage(row.packageId);
  const pkg = meta ? await deps.packages.get(meta.stagedKey) : null;
  if (!pkg) return { status: 'failed', error: bridgeError('internal', 'package expired') };
  const result = await sink.deliver({
    instanceId: target.instanceId,
    credential: null,
    destination: { ...target.destination, ...row.overrides },
    idempotencyKey: row.idempotencyKey,
    actingUser: row.actingUser,
    package: pkg,
  });
  if (result.status === 'succeeded') return { status: 'succeeded', receipt: result.receipt };
  return {
    status: 'waiting',
    sinkJobId: result.sinkJobId,
    runAfter: later(now, deps.pollSeconds ?? 30),
  };
}

/**
 * Runs one due delivery: polls a pending sink job, skips a repeat a sink can neither replace nor
 * withdraw, or delivers the staged package. Failures stop for a person (`needs_user`) or retry
 * with backoff until `maxAttempts`.
 */
export async function runOnce(deps: RunnerDeps, now: Date): Promise<'idle' | 'worked'> {
  const row = await deps.deliveries.claim(now, deps.leaseSeconds);
  if (!row) return 'idle';
  let transition: Transition;
  try {
    transition = await step(row, deps, now);
  } catch (err) {
    transition = onError(row, asBridgeError(err), deps, now);
  }
  // False when this run's lease expired and another runner took the delivery over: its outcome
  // stands, and this late one is dropped.
  await deps.deliveries.transition(row.id, transition, now, row.claimId);
  return 'worked';
}
