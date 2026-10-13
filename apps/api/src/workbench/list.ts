import type { FastifyInstance } from 'fastify';
import {
  ProjectListItemSchema,
  queryProjects,
  type ProjectListItem,
  type ProjectListPage,
  type ProjectListQuery,
} from '@ih/shared';
import { projectListItem } from '../routes/workbench-overview.js';

/** Rows recomputed at once on a cold or mostly stale cache. */
const RECOMPUTE_CONCURRENCY = 8;

/**
 * Salts every cached fingerprint: bump it when the list row's shape or the code deriving it
 * (the overview, `listItemFrom`) changes, so a deploy invalidates every cached row.
 */
export const LIST_CACHE_VERSION = 2;

/**
 * Every project's list row, recomputing only those whose fingerprint moved (or whose cached row
 * is missing, of another `LIST_CACHE_VERSION`, or no longer parses). The fingerprints are read
 * before any row is computed and a row is stored under that earlier fingerprint, so a change
 * made during the computation leaves it stale for the next request rather than hiding it. A row
 * computed while a store read failed (`degraded`) answers this request but is not stored.
 * Concurrent callers share one refresh per app, so a request that joins an in-flight refresh
 * can get rows from before a change made meanwhile (it shows on the next request). A project
 * deleted after the fingerprints were read is left out. `lastActivityAt` always comes from the
 * fresh fingerprint.
 */
export function refreshListCache(app: FastifyInstance): Promise<ProjectListItem[]> {
  const running = inFlight.get(app);
  if (running) return running;
  const started = computeListCache(app).finally(() => {
    if (inFlight.get(app) === started) inFlight.delete(app);
  });
  inFlight.set(app, started);
  return started;
}

/**
 * Fills the cache after a start or deploy. A second pass absorbs rows whose computation wrote
 * gate/score caches and so moved their own fingerprint.
 */
export async function warmListCache(app: FastifyInstance): Promise<void> {
  await refreshListCache(app);
  await refreshListCache(app);
}

const inFlight = new WeakMap<FastifyInstance, Promise<ProjectListItem[]>>();

async function computeListCache(app: FastifyInstance): Promise<ProjectListItem[]> {
  const { workbench } = app.deps;
  const fingerprints = await workbench.projectFingerprints();
  const cache = await workbench.listCache();
  const key = (fingerprint: string) => `${LIST_CACHE_VERSION}:${fingerprint}`;
  const rows = new Map<string, ProjectListItem>();
  const stale: typeof fingerprints = [];
  for (const f of fingerprints) {
    const cached = cache.get(f.id);
    const parsed =
      cached?.fingerprint === key(f.fingerprint)
        ? ProjectListItemSchema.safeParse(cached.item)
        : null;
    if (parsed?.success) rows.set(f.id, { ...parsed.data, lastActivityAt: f.lastActivityAt });
    else stale.push(f);
  }
  let next = 0;
  const work = async () => {
    while (next < stale.length) {
      const f = stale[next++]!;
      const project = await workbench.getProject(f.id);
      if (!project) continue;
      let computed: Awaited<ReturnType<typeof projectListItem>>;
      try {
        computed = await projectListItem(app, project, f.lastActivityAt);
      } catch (err) {
        // Deleted while its row was computed (its rows vanish under the overview's reads).
        if (!(await workbench.getProject(f.id))) continue;
        throw err;
      }
      // Deleted during a computation that still succeeded: not listed (the upsert would no-op).
      if (!(await workbench.getProject(f.id))) continue;
      const { item, degraded } = computed;
      if (!degraded) await workbench.putListCache(f.id, key(f.fingerprint), item);
      rows.set(f.id, item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECOMPUTE_CONCURRENCY, stale.length) }, work));
  // In fingerprint order, whatever order the recomputations finished in.
  return fingerprints.flatMap((f) => rows.get(f.id) ?? []);
}

/** GET /api/workbench/projects: the cached rows, searched, counted, sorted and paged (W1). */
export async function listProjectsPage(
  app: FastifyInstance,
  query: ProjectListQuery,
): Promise<ProjectListPage> {
  return queryProjects(await refreshListCache(app), query);
}
