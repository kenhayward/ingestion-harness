import type { FastifyBaseLogger } from 'fastify';
import { decryptSecret, type SecretsKeys } from '../llm/secrets.js';
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
 * bridge's shared connection `target-<id>`, the bridge's target is pointed at it (its place
 * unchanged) and cached, and the legacy row is dropped. Keys read from `.env` (an env-keyed
 * default) become an env connection: the bridge reads the same allowlisted variables in its own
 * container. A row an earlier move already took is dropped. A row whose secret cannot be
 * decrypted, that has no keys, or whose connection the bridge refuses is skipped and logged; it
 * stays for the next try.
 */
export async function moveTargetsToBridge(
  deps: SyncDeps & { secrets: SecretsKeys | null },
): Promise<{ moved: string[]; skipped: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const k of await deps.targets.legacyKeys()) {
    if (k.movedToBridgeAt !== null) {
      await deps.targets.dropLegacyKeys(k.id);
      continue;
    }
    const t = await deps.targets.get(k.id);
    if (!t || t.kind !== 'external') continue;
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
    const connectionId = movedConnectionId(t.id);
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
}

/** One pass: move what is left to move, seed from `.env`, then pull the whole registry. */
async function syncOnce(deps: TargetSyncDeps): Promise<TargetSyncResult> {
  const { moved, skipped } = await moveTargetsToBridge(deps);
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
  return { moved, skipped, seeded, pulled: await pullTargets(deps) };
}

/**
 * At API start: one pass, retried until the bridge answers (it may start after the API). Runs in
 * the background; publishing waits on the bridge anyway, and the worker retries a delivery the
 * bridge cannot take yet.
 */
export async function startTargetSync(
  deps: TargetSyncDeps,
  opts: { retryMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TargetSyncResult> {
  const retryMs = opts.retryMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      return await syncOnce(deps);
    } catch (err) {
      deps.log.warn({ err }, `publishing targets could not be synced with the bridge yet`);
      await sleep(retryMs);
    }
  }
}

/**
 * After a restore swapped the database in: the same pass. A restored target's keys from before
 * the bridge move there, the triple store target is seeded again from RDF_ENDPOINT when the
 * restored database lacks it (a backup from before it), and the cache takes the registry again.
 */
export function resyncAfterRestore(
  deps: TargetSyncDeps,
  opts: Parameters<typeof startTargetSync>[1] = {},
): Promise<TargetSyncResult> {
  return startTargetSync(deps, opts);
}
