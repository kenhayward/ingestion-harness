import {
  bridgeError,
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
export async function acceptDeliveries(
  deps: AcceptDeps,
  req: CreateDeliveriesRequest,
  now: Date,
  ids: () => string,
): Promise<CreateDeliveriesResult> {
  const parts = partsOf(req.package);
  const destinations = new Map<string, Record<string, string>>();
  for (const targetId of req.targets) {
    const target = await deps.targets.get(targetId);
    if (!target) {
      throw new SinkError(bridgeError('target_missing', `no target ${targetId}`, { targetId }));
    }
    const sink = deps.sinks.get(target.sinkId);
    if (!sink) {
      throw new SinkError(
        bridgeError('sink_unavailable', `the sink of ${target.label} is not available`, {
          targetId,
          sinkId: target.sinkId,
        }),
      );
    }
    if (deps.sinks.status(target.sinkId) === 'unavailable') {
      throw new SinkError(
        bridgeError('sink_unavailable', `the sink of ${target.label} is not available`, {
          targetId,
          sinkId: target.sinkId,
        }),
      );
    }
    const { capabilities, connectionKind, destinationFields } = await sink.describe();
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
    if (connectionKind === 'personal') {
      const user = req.actingUser;
      if (!user) {
        throw new SinkError(
          bridgeError(
            'connection_missing',
            `delivering to ${target.label} needs a person to deliver as`,
            {
              targetId,
            },
          ),
        );
      }
      if (!(await deps.connections.findPersonal(user.id, target.sinkId, target.instanceId))) {
        throw new SinkError(
          bridgeError(
            'connection_missing',
            `${user.name} has no connection for ${target.label}: add one on the connections page`,
            { targetId, userId: user.id },
          ),
        );
      }
    }
    const refused = parts.find((p) => !capabilities.accepts.includes(p));
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
