import { TRIPLE_STORE_TARGET_ID } from '@ih/shared';
import type { FastifyBaseLogger } from 'fastify';
import { decryptSecret, type SecretsKeys } from '../llm/secrets.js';
import { INTERNAL_CONNECTION_ID } from '../publish-targets/place.js';
import type { PublishTargetRepo, SeedOutcome } from '../publish-targets/repo.js';
import {
  ensureRdfConnection,
  seedDefault,
  seedRdf,
  type DefaultSeed,
  type RdfSeed,
} from '../publish-targets/seed.js';
import { BridgeApiError, type BridgeApi } from './client.js';

export { ensureRdfConnection };

/**
 * The delivery bridge's target registry is authoritative for where and how a target delivers;
 * `publish_targets` is CT Studio's cache of it (plus CT Studio's own facts), kept because the
 * delivery records' foreign keys, the in-use guard, read-key grants and backup rules need a
 * local row. Writes go to the bridge first and cache its answer; `pullTargets` takes the whole
 * registry at start and after every restore.
 */

interface SyncDeps {
  targets: PublishTargetRepo;
  bridge: BridgeApi;
  log: FastifyBaseLogger;
}

/**
 * Caches every target the bridge lists (on the bridge, synced now; CT Studio's own facts and
 * `inert_at` untouched). A cached row the bridge no longer lists is kept (the foreign keys) and
 * marked not on the bridge; a live one is logged. Nothing is written to the bridge.
 */
export async function pullTargets(deps: SyncDeps): Promise<{ cached: number; missing: string[] }> {
  const listed = await deps.bridge.listTargets();
  for (const view of listed) await deps.targets.cache(view, {});
  const ids = new Set(listed.map((v) => v.id));
  const gone = (await deps.targets.cachedIds()).filter((c) => !ids.has(c.id));
  await deps.targets.markMissing(gone.map((c) => c.id));
  const missing = gone.filter((c) => c.live).map((c) => c.id);
  for (const id of missing) {
    deps.log.warn(
      { target: id },
      `publishing target ${id} is not on the delivery bridge: its deliveries fail until it is added there again`,
    );
  }
  return { cached: listed.length, missing };
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

/** The connection a move makes for a target. */
export const movedConnectionId = (targetId: string): string => `target-${targetId}`;

/**
 * One-off, per row of `publish_target_legacy_keys`: an external target's keys become the
 * bridge's shared connection `target-<id>` (`target-<id>-2`, … when a connection of that id
 * exists already: one an admin made is never overwritten), the bridge's target is pointed at it
 * (its place unchanged) and cached, and the legacy row is dropped. The connection chosen is
 * recorded on the legacy row before it is written, so a try whose target write failed is retried
 * with the same connection, never a new copy of the secret. A target an admin already gave
 * a connection keeps it: only its legacy row is dropped. Keys read from `.env` (an env-keyed
 * default) become an env connection: the bridge reads the same allowlisted variables in its own
 * container. A row an earlier move already took is dropped. A row whose secret cannot be
 * decrypted, that has no keys, or whose connection the bridge refuses is skipped and logged; it
 * stays for the next try. A row of a target that is not external (an internal one never delivers
 * with its own keys) or not live (inert after a copy restore: production's keys) is dropped.
 */
export async function moveTargetsToBridge(
  deps: SyncDeps & { secrets: SecretsKeys | null },
): Promise<{ moved: string[]; skipped: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];
  let taken: Set<string> | null = null;
  for (const k of await deps.targets.legacyKeys()) {
    if (k.movedToBridgeAt !== null) {
      await deps.targets.dropLegacyKeys(k.id);
      continue;
    }
    const t = await deps.targets.get(k.id);
    if (!t || t.kind !== 'external') {
      await deps.targets.dropLegacyKeys(k.id);
      continue;
    }
    if (t.connectionId !== null) {
      // An admin picked a connection before the move ran: that one stays, and the row's own
      // keys, which nothing uses any more, are dropped.
      await deps.targets.dropLegacyKeys(k.id);
      moved.push(t.id);
      continue;
    }
    const fields: Record<string, string> = {};
    if (k.endpoint) fields.endpoint = k.endpoint;
    if (k.region) fields.region = k.region;
    let secret: string | null = null;
    let secretEnv: string | null = null;
    if (k.secretKeyEnc) {
      try {
        if (!deps.secrets) throw new Error('LLM_SECRETS_KEY is not set');
        secret = decryptSecret(k.secretKeyEnc, deps.secrets);
      } catch {
        deps.log.warn(
          { target: t.id },
          `publishing target ${t.id}: its secret cannot be decrypted, so its keys were not moved to the bridge; enter them on the connections page`,
        );
        skipped.push(t.id);
        continue;
      }
    } else if (k.secretKeyEnv) {
      secretEnv = k.secretKeyEnv;
    } else {
      deps.log.warn(
        { target: t.id },
        `publishing target ${t.id} has no keys to move to the bridge; enter them on the connections page`,
      );
      skipped.push(t.id);
      continue;
    }
    if (k.accessKeyId) fields.accessKeyId = k.accessKeyId;
    else if (k.accessKeyEnv) fields.accessKeyIdEnv = k.accessKeyEnv;
    fields.forcePathStyle = String(k.forcePathStyle);
    // A retry reuses the connection its own earlier try chose (and may have written). Otherwise
    // never over an existing connection (one an admin made under that name): the next free id,
    // recorded before it is written.
    let connectionId = k.connectionId;
    if (connectionId === null) {
      taken ??= new Set((await deps.bridge.listConnections('shared')).map((c) => c.id));
      connectionId = movedConnectionId(t.id);
      for (let n = 2; taken.has(connectionId); n++) {
        connectionId = `${movedConnectionId(t.id)}-${n}`;
      }
      taken.add(connectionId);
      await deps.targets.chooseLegacyConnection(t.id, connectionId);
    }
    try {
      await deps.bridge.putSharedConnection({
        id: connectionId,
        name: t.label,
        fields,
        secret,
        secretEnv,
      });
      const view = await deps.bridge.putTarget(t.id, {
        label: t.label,
        sinkId: t.sinkId,
        instanceId: t.instanceId,
        connectionId,
        destination: t.destination,
      });
      await deps.targets.cache(view, {});
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
    await deps.targets.dropLegacyKeys(t.id);
    moved.push(t.id);
  }
  return { moved, skipped };
}

/**
 * After a restore, before the pull: every live cached target the bridge lacks is written to the
 * bridge from the cache, so a backup from before the merge (whose targets the bridge never held)
 * gets its targets back rather than having them marked missing. Internal targets deliver with
 * the built-in connection, the triple store with its own; an external one with the connection
 * it names, but only once its keys have moved (a row still in `publish_target_legacy_keys` is
 * left to the next move). A row never synced (the unseeded default) is left to the seed; one the
 * bridge refuses is logged and skipped.
 */
export async function putMissingTargets(deps: TargetSyncDeps): Promise<string[]> {
  const listed = new Set((await deps.bridge.listTargets()).map((v) => v.id));
  const unmoved = new Set((await deps.targets.legacyKeys()).map((k) => k.id));
  const put: string[] = [];
  for (const c of await deps.targets.cachedIds()) {
    if (!c.live || listed.has(c.id) || unmoved.has(c.id)) continue;
    const t = await deps.targets.get(c.id);
    if (!t || t.syncedAt === null) continue;
    const connectionId =
      t.kind === 'internal'
        ? INTERNAL_CONNECTION_ID
        : t.kind === 'rdf'
          ? TRIPLE_STORE_TARGET_ID
          : t.connectionId;
    try {
      if (t.kind === 'rdf' && deps.rdfSeed) await ensureRdfConnection(deps.bridge, deps.rdfSeed);
      const view = await deps.bridge.putTarget(t.id, {
        label: t.label,
        sinkId: t.sinkId,
        instanceId: t.instanceId,
        connectionId,
        destination: t.destination,
      });
      await deps.targets.cache(view, {});
    } catch (err) {
      const why = refusal(err);
      if (why === null) throw err;
      deps.log.warn(
        { target: t.id },
        `publishing target ${t.id} could not be written back to the bridge after the restore: the bridge refused it (${why})`,
      );
      continue;
    }
    put.push(t.id);
  }
  return put;
}

export interface TargetSyncDeps extends SyncDeps {
  secrets: SecretsKeys | null;
  /** The default from `.env`. */
  seed: DefaultSeed;
  /** The triple store from RDF_ENDPOINT (null: none). */
  rdfSeed: RdfSeed | null;
}

export interface TargetSyncResult {
  moved: string[];
  skipped: string[];
  /** `refused`: the bridge refused the seed (logged); the rest of the pass went on. */
  seeded: { default: SeedOutcome | 'refused'; rdf: SeedOutcome | 'refused' | null };
  pulled: { cached: number; missing: string[] };
  /** After a restore only: the cached targets written back to the bridge (`putMissingTargets`). */
  restored?: string[];
}

/**
 * One pass: move what is left to move, (after a restore) write back what the bridge lacks, seed
 * from `.env`, then pull the whole registry.
 */
async function syncOnce(deps: TargetSyncDeps, afterRestore: boolean): Promise<TargetSyncResult> {
  const { moved, skipped } = await moveTargetsToBridge(deps);
  const restored = afterRestore ? await putMissingTargets(deps) : undefined;
  const refusedOr = async (what: string, seed: () => Promise<SeedOutcome>) => {
    try {
      return await seed();
    } catch (err) {
      const why = refusal(err);
      if (why === null) throw err;
      deps.log.warn(`${what} could not be seeded: the bridge refused it (${why})`);
      return 'refused' as const;
    }
  };
  const rdfSeed = deps.rdfSeed;
  const seeded = {
    default: await refusedOr('publishing target default', () => seedDefault(deps, deps.seed)),
    rdf: rdfSeed ? await refusedOr('the triple store target', () => seedRdf(deps, rdfSeed)) : null,
  };
  const pulled = await pullTargets(deps);
  return restored
    ? { moved, skipped, restored, seeded, pulled }
    : { moved, skipped, seeded, pulled };
}

/**
 * At API start: one pass, retried until the bridge answers (it may start after the API). Runs in
 * the background; publishing waits on the bridge anyway, and the worker retries a delivery the
 * bridge cannot take yet.
 */
export function startTargetSync(
  deps: TargetSyncDeps,
  opts: SyncOptions = {},
): Promise<TargetSyncResult> {
  return syncUntilDone(deps, opts, false);
}

interface SyncOptions {
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function syncUntilDone(
  deps: TargetSyncDeps,
  opts: SyncOptions,
  afterRestore: boolean,
): Promise<TargetSyncResult> {
  const retryMs = opts.retryMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      return await syncOnce(deps, afterRestore);
    } catch (err) {
      deps.log.warn({ err }, `publishing targets could not be synced with the bridge yet`);
      await sleep(retryMs);
    }
  }
}

/**
 * After a restore swapped the database in: the same pass, plus one step. A restored target's
 * keys from before the bridge move there; the restored cache's live targets the bridge lacks are
 * written back to it (`putMissingTargets`: a backup from before the merge); the triple store
 * target is seeded again from RDF_ENDPOINT when the restored database lacks it (a backup from
 * before it); and the cache takes the registry again.
 */
export function resyncAfterRestore(
  deps: TargetSyncDeps,
  opts: SyncOptions = {},
): Promise<TargetSyncResult> {
  return syncUntilDone(deps, opts, true);
}
