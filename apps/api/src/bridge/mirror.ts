import { TRIPLE_STORE_TARGET_ID } from '@ih/shared';
import type { FastifyBaseLogger } from 'fastify';
import { decryptSecret, type SecretsKeys } from '../llm/secrets.js';
import type { PublishTargetRepo, TargetRecord } from '../publish-targets/repo.js';
import type { RdfSeed } from '../publish-targets/seed.js';
import { BridgeApiError, type BridgeApi, type TargetMirror } from './client.js';

/**
 * CT Studio keeps `publish_targets` as its recipient registry (their usage, locking, read-key
 * grants and backup rules); the bridge is authoritative for where and how a target delivers.
 * Every target is mirrored to the bridge on each write and at start.
 */

/** The bridge's built-in connection: the deployment's own S3, for internal targets. */
export const INTERNAL_CONNECTION_ID = 'internal';

/** The S3 sink's destination of a target row; unset options are blank. */
export function destinationOf(t: TargetRecord): Record<string, string> {
  return {
    bucket: t.bucket,
    prefix: t.prefix,
    sse: t.sse,
    kmsKeyId: t.kmsKeyId ?? '',
    storageClass: t.storageClass ?? '',
    layout: t.layout,
  };
}

/** The connection a target delivers with: internal targets the built-in one. */
export function connectionIdOf(t: TargetRecord): string | null {
  return t.kind === 'internal' ? INTERNAL_CONNECTION_ID : t.connectionId;
}

export function mirrorOf(t: TargetRecord): TargetMirror {
  if (t.kind === 'rdf') {
    // The triple store: its dataset, written with its own connection (the endpoint and the
    // writer's user; the password from the bridge's RDF_PASSWORD, or one an admin stored).
    return {
      label: t.label,
      sinkId: 'rdf',
      instanceId: null,
      connectionId: TRIPLE_STORE_TARGET_ID,
      destination: { dataset: t.bucket },
    };
  }
  return {
    label: t.label,
    sinkId: 's3',
    instanceId: null,
    connectionId: connectionIdOf(t),
    destination: destinationOf(t),
  };
}

/**
 * The triple store's connection, made from `.env` when the bridge has none yet: the endpoint and
 * the writer's user, its password read from the bridge's own RDF_PASSWORD. One the bridge already
 * has is left alone, so a password an admin stored on the connections page stays.
 */
async function ensureRdfConnection(bridge: BridgeApi, t: TargetRecord): Promise<void> {
  const existing = await bridge.listConnections('shared');
  if (existing.some((c) => c.id === TRIPLE_STORE_TARGET_ID)) return;
  await bridge.putSharedConnection({
    id: TRIPLE_STORE_TARGET_ID,
    name: 'Triple store',
    sinkId: 'rdf',
    fields: { endpoint: t.endpoint ?? '', user: t.accessKeyId ?? '' },
    secret: null,
    secretEnv: 'RDF_PASSWORD',
  });
}

/**
 * The bridge refused this one request (it answered, and not about this deployment's key): the
 * row is at fault, so it is logged and skipped rather than holding up every other row. An
 * unreachable or failing bridge is not a refusal; the whole sync is tried again.
 */
function refusal(err: unknown): string | null {
  if (!(err instanceof BridgeApiError) || err.status < 400 || err.status >= 500) return null;
  return err.status === 401 ? null : (err.error?.message ?? err.message);
}

/**
 * Pushes every target row to the bridge (idempotent). A row the bridge refuses is logged and
 * left out. Returns how many were pushed.
 */
export async function mirrorTargets(deps: {
  targets: PublishTargetRepo;
  bridge: BridgeApi;
  log: FastifyBaseLogger;
}): Promise<number> {
  let n = 0;
  for (const view of await deps.targets.list()) {
    const record = await deps.targets.get(view.id);
    if (!record) continue;
    if (record.kind === 'rdf') await ensureRdfConnection(deps.bridge, record);
    const mirror = mirrorOf(record);
    try {
      try {
        await deps.bridge.putTarget(record.id, mirror);
      } catch (err) {
        // A connection the bridge does not have (a restore kept this server's connections): the
        // target is mirrored without one, so its deliveries fail visibly until an admin picks one.
        if (!(err instanceof BridgeApiError && err.error?.code === 'connection_missing')) throw err;
        await deps.bridge.putTarget(record.id, { ...mirror, connectionId: null });
      }
    } catch (err) {
      const why = refusal(err);
      if (why === null) throw err;
      deps.log.warn(
        { target: record.id },
        `publishing target ${record.id} was refused by the bridge: ${why}`,
      );
      continue;
    }
    n += 1;
  }
  return n;
}

/** The connection a move makes for a target. */
export const movedConnectionId = (targetId: string): string => `target-${targetId}`;

/**
 * One-off, per row: an external target's keys become the bridge's shared connection
 * `target-<id>`, then the row's ciphertext is dropped and `moved_to_bridge_at` set. Keys read
 * from `.env` (the seeded default) become an env connection: the bridge reads the same allowlisted
 * variables in its own container. A row whose secret cannot be decrypted, or that has no keys, is
 * skipped and logged, as is one whose connection the bridge refuses; it is mirrored without a
 * connection, so its deliveries fail visibly.
 */
export async function moveTargetsToBridge(deps: {
  targets: PublishTargetRepo;
  bridge: BridgeApi;
  secrets: SecretsKeys | null;
  log: FastifyBaseLogger;
}): Promise<{ moved: string[]; skipped: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const view of await deps.targets.list()) {
    const t = await deps.targets.get(view.id);
    if (!t || t.kind !== 'external' || t.movedToBridgeAt !== null) continue;
    const fields: Record<string, string> = {};
    if (t.endpoint) fields.endpoint = t.endpoint;
    if (t.region) fields.region = t.region;
    let secret: string | null = null;
    let secretEnv: string | null = null;
    if (t.secretKeyEnc) {
      try {
        if (!deps.secrets) throw new Error('LLM_SECRETS_KEY is not set');
        secret = decryptSecret(t.secretKeyEnc, deps.secrets);
      } catch {
        deps.log.warn(
          { target: t.id },
          `publishing target ${t.id}: its secret cannot be decrypted, so its keys were not moved to the bridge; enter them on the connections page`,
        );
        skipped.push(t.id);
        continue;
      }
      if (t.accessKeyId) fields.accessKeyId = t.accessKeyId;
      else if (t.accessKeyEnv) fields.accessKeyIdEnv = t.accessKeyEnv;
    } else if (t.secretKeyEnv) {
      secretEnv = t.secretKeyEnv;
      if (t.accessKeyId) fields.accessKeyId = t.accessKeyId;
      else if (t.accessKeyEnv) fields.accessKeyIdEnv = t.accessKeyEnv;
    } else {
      deps.log.warn(
        { target: t.id },
        `publishing target ${t.id} has no keys to move to the bridge; enter them on the connections page`,
      );
      skipped.push(t.id);
      continue;
    }
    fields.forcePathStyle = String(t.forcePathStyle);
    const connectionId = movedConnectionId(t.id);
    try {
      await deps.bridge.putSharedConnection({
        id: connectionId,
        name: t.label,
        fields,
        secret,
        secretEnv,
      });
    } catch (err) {
      const why = refusal(err);
      if (why === null) throw err;
      deps.log.warn(
        { target: t.id },
        `publishing target ${t.id}: the bridge refused its connection (${why}), so its keys were not moved; enter them on the connections page`,
      );
      skipped.push(t.id);
      continue;
    }
    await deps.targets.markMoved(t.id, connectionId);
    moved.push(t.id);
  }
  await mirrorTargets(deps);
  return { moved, skipped };
}

/**
 * At API start: move what is left to move, then mirror every target, retrying until the bridge
 * answers (it may start after the API). Runs in the background; publishing waits on the bridge
 * anyway, and the worker retries a delivery the bridge cannot take yet.
 */
export async function syncTargetsWithBridge(
  deps: Parameters<typeof moveTargetsToBridge>[0],
  opts: { retryMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ moved: string[]; skipped: string[] }> {
  const retryMs = opts.retryMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      return await moveTargetsToBridge(deps);
    } catch (err) {
      deps.log.warn({ err }, `publishing targets could not be synced with the bridge yet`);
      await sleep(retryMs);
    }
  }
}

/**
 * After a restore swapped the database in: the triple store target is seeded again from
 * RDF_ENDPOINT (a backup from before it has none, and the worker would otherwise load nothing
 * into Fuseki and drop no graph on withdraw), then every target is mirrored again (and a
 * restored target's keys from before the bridge are moved there).
 */
export async function resyncAfterRestore(
  deps: Parameters<typeof moveTargetsToBridge>[0] & { rdfSeed: RdfSeed | null },
  opts: Parameters<typeof syncTargetsWithBridge>[1] = {},
): Promise<{ moved: string[]; skipped: string[] }> {
  if (deps.rdfSeed) await deps.targets.seedRdf(deps.rdfSeed);
  return syncTargetsWithBridge(deps, opts);
}
