import {
  bridgeError,
  type ActingUser,
  partsOf,
  type BridgePackage,
  type CreateDeliveriesRequest,
  type CreateDeliveriesResult,
} from '@ih/bridge-contract';
import type { ConnectionRepo } from '../connections/repo.js';
import { resolveDestination } from './destination.js';
import type { PackageStore } from '../packages/store.js';
import { SinkError, type SinkRegistry } from '../sinks/port.js';
import type { TargetRepo } from '../targets/repo.js';
import type { DeliveryRepo } from './repo.js';

export interface AcceptDeps {
  deliveries: DeliveryRepo;
  packages: PackageStore;
  targets: TargetRepo;
  sinks: SinkRegistry;
  /** Where a personal sink's deliveries find the acting user's connection. */
  connections: ConnectionRepo;
  retentionDays: number;
}

/** The package as recorded in the database: everything but the bytes. */
export function manifestOf(pkg: BridgePackage): unknown {
  return {
    ...pkg,
    files: pkg.files.map(({ content: _c, ...f }) => f),
    images: pkg.images?.map(({ content: _c, ...i }) => i) ?? null,
  };
}

/**
 * Accepts a package for its targets, all or nothing: every target must exist, have a registered
 * sink, and that sink must take every part the package carries; a personal sink's target also
 * needs an acting user who holds a connection for its instance. The first problem throws a
 * SinkError before anything is written.
 */
/**
 * A target ready to take a delivery as `actingUser`: it exists, its sink is registered and
 * available, and a personal sink's target has that user's connection to its instance. Throws the
 * SinkError of the first problem. Accept and preflight share it.
 */
export async function readyTarget(
  deps: Pick<AcceptDeps, 'targets' | 'sinks' | 'connections'>,
  targetId: string,
  actingUser: ActingUser | null,
) {
  const target = await deps.targets.get(targetId);
  if (!target) {
    throw new SinkError(bridgeError('target_missing', `no target ${targetId}`, { targetId }));
  }
  const sink = deps.sinks.get(target.sinkId);
  if (!sink || deps.sinks.status(target.sinkId) === 'unavailable') {
    throw new SinkError(
      bridgeError('sink_unavailable', `the sink of ${target.label} is not available`, {
        targetId,
        sinkId: target.sinkId,
      }),
    );
  }
  const described = await sink.describe();
  if (described.connectionKind === 'personal') {
    if (!actingUser) {
      throw new SinkError(
        bridgeError(
          'connection_missing',
          `delivering to ${target.label} needs a person to deliver as`,
          { targetId },
        ),
      );
    }
    if (!(await deps.connections.findPersonal(actingUser.id, target.sinkId, target.instanceId))) {
      throw new SinkError(
        bridgeError(
          'connection_missing',
          `${actingUser.name} has no connection for ${target.label}: add one on the connections page`,
          { targetId, userId: actingUser.id },
        ),
      );
    }
  }
  return { target, described };
}

export async function acceptDeliveries(
  deps: AcceptDeps,
  req: CreateDeliveriesRequest,
  now: Date,
  ids: () => string,
): Promise<CreateDeliveriesResult> {
  const parts = partsOf(req.package);
  const destinations = new Map<string, Record<string, string>>();
  for (const targetId of req.targets) {
    const { target, described } = await readyTarget(deps, targetId, req.actingUser);
    const { capabilities, destinationFields } = described;
    destinations.set(
      targetId,
      resolveDestination({
        targetId,
        target,
        fields: destinationFields,
        patterns: req.patterns[targetId] ?? {},
        overrides: req.overrides[targetId] ?? {},
        naming: req.package.naming,
      }),
    );
    // A decomposed document goes only to a sink that says it takes them (never a version 1 sink).
    const refused =
      req.package.document && !capabilities.decomposedDocuments
        ? 'document'
        : parts.find((p) => !capabilities.accepts.includes(p));
    if (refused) {
      throw new SinkError(
        bridgeError('unsupported_part', `${target.label} does not take ${refused}`, {
          targetId,
          part: refused,
        }),
      );
    }
  }
  const packageId = ids();
  const stagedKey = `packages/${packageId}.json`;
  await deps.packages.put(stagedKey, req.package);
  const deliveries = req.targets.map((targetId) => ({
    id: ids(),
    targetId,
    actingUser: req.actingUser,
    overrides: req.overrides[targetId] ?? {},
    destination: destinations.get(targetId) ?? null,
    // The schema allows an update only with exactly one target.
    update: req.update ?? null,
  }));
  await deps.deliveries.create(
    {
      id: packageId,
      kind: req.package.kind,
      idempotencyKey: req.package.idempotencyKey,
      manifest: manifestOf(req.package),
      stagedKey,
      expiresAt: new Date(now.getTime() + deps.retentionDays * 86_400_000),
    },
    deliveries,
    now,
  );
  return {
    packageId,
    deliveries: deliveries.map((d) => ({ targetId: d.targetId, deliveryId: d.id })),
  };
}
