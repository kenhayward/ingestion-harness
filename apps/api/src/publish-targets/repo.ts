import type { TargetView } from '@ih/bridge-contract';
import {
  DEFAULT_TARGET_ID,
  publishTargetsOf,
  targetInUse,
  type PublishTargetKind,
  type PublishTargetView,
  type TargetChoice,
  type TargetUsage,
} from '@ih/shared';
import { kindOf, s3OptionsOf, s3PlaceOf } from './place.js';

/**
 * A cached target: the bridge's target (it is authoritative for where and how a target
 * delivers) plus what only CT Studio knows (where it came from, who edited it and when).
 */
export interface TargetRecord {
  id: string;
  label: string;
  /** Set by the cache writer from the sink and connection (`kindOf`). */
  kind: PublishTargetKind;
  sinkId: string;
  instanceId: string | null;
  connectionId: string | null;
  destination: Record<string, string>;
  /** False when the bridge's list last lacked it. */
  onBridge: boolean;
  /** When the cache last took it from the bridge (null: not yet). */
  syncedAt: string | null;
  source: 'env' | 'ui';
  seededAt: string | null;
  editedAt: string | null;
  updatedBy: string | null;
  createdAt: string;
}

/**
 * CT Studio's facts a cache write sets; those left out are kept (a new row: `ui`, never seeded,
 * nobody). `by`: an edit made here (who; `edited_at` is stamped when the row was there already).
 */
export interface CacheFacts {
  source?: 'env' | 'ui';
  seededAt?: string | null;
  by?: string | null;
}

/**
 * Keys a target held before they moved to the bridge (`publish_target_legacy_keys`): read once,
 * by the move, then dropped.
 */
export interface LegacyKeys {
  id: string;
  endpoint: string | null;
  region: string | null;
  accessKeyId: string | null;
  secretKeyEnc: string | null;
  accessKeyEnv: string | null;
  secretKeyEnv: string | null;
  forcePathStyle: boolean;
  movedToBridgeAt: string | null;
  /** The connection a move chose for these keys (set before it writes it; null: none yet). */
  connectionId: string | null;
}

export type SeedOutcome = 'seeded' | 'kept' | 'differs';

export interface PublishTargetRepo {
  list(): Promise<PublishTargetView[]>;
  get(id: string): Promise<TargetRecord | null>;
  /** Upserts the bridge's view of a target: on the bridge, synced now. Inert rows stay inert. */
  cache(view: TargetView, facts?: CacheFacts): Promise<TargetRecord>;
  /** The bridge no longer lists these: kept (the foreign keys), marked not on the bridge. */
  markMissing(ids: string[]): Promise<void>;
  /** Every cached id, inert ones too (`live: false`). */
  cachedIds(): Promise<{ id: string; live: boolean }[]>;
  /**
   * Makes the target inert (never deleted: delivery records may still name it, and its id stays
   * taken). `seeded`: the triple store target, which comes from `.env` and is never removed.
   * `onBridge` runs after the usage check and before the row goes inert (in Postgres, holding the
   * row's lock: an output or graph copy recorded against it meanwhile waits, then names the inert
   * target); `false` from it refuses (`refused`),
   * and a throw leaves the row as it was.
   */
  remove(
    id: string,
    onBridge?: () => Promise<boolean>,
  ): Promise<'deleted' | 'missing' | 'default' | 'seeded' | 'in_use' | 'refused'>;
  usage(id: string): Promise<TargetUsage>;
  /** What a recipe's picker offers (S3 targets): the default first, then by label. */
  choices(): Promise<TargetChoice[]>;
  /** Moves on every write, so readers rebuild their stores. */
  version(): Promise<number>;
  /** Keys from before the bridge not dropped yet, by id. */
  legacyKeys(): Promise<LegacyKeys[]>;
  dropLegacyKeys(id: string): Promise<void>;
  /** Records the connection a move is about to write for these keys, so a retry reuses it. */
  chooseLegacyConnection(id: string, connectionId: string): Promise<void>;
  /** The bridge connection a target delivers with (null: none, or no such target). */
  connectionOf(id: string): Promise<string | null>;
}

export const EMPTY_USAGE: TargetUsage = {
  publishedVersions: 0,
  documentTypes: [],
  deliveredOutputs: 0,
  consumers: 0,
  pendingJobs: 0,
};

/**
 * The view of a record: an S3 target's place and options read from its destination (null for
 * other sinks; the triple store's dataset shows as its bucket). The route fills in the
 * connection as the bridge describes it, and the triple store's endpoint from that connection.
 */
export function toView(r: TargetRecord, usage: TargetUsage): PublishTargetView {
  const place = s3PlaceOf(r);
  const options = s3OptionsOf(r);
  return {
    id: r.id,
    label: r.label,
    kind: r.kind,
    sinkId: r.sinkId,
    destination: r.destination,
    onBridge: r.onBridge,
    bucket: place?.bucket ?? (r.kind === 'rdf' ? (r.destination.dataset ?? null) : null),
    prefix: place?.prefix ?? null,
    endpoint: null,
    // Internal targets deliver with the bridge's built-in connection, which the kind says.
    connectionId: r.kind === 'internal' ? null : r.connectionId,
    connection: null,
    sse: options?.sse ?? null,
    kmsKeyId: options?.kmsKeyId ?? null,
    storageClass: options?.storageClass ?? null,
    layout: place?.layout ?? null,
    sinkName: null,
    deliverOnly: false,
    source: r.source,
    editedAt: r.editedAt,
    updatedBy: r.updatedBy,
    createdAt: r.createdAt,
    usage,
  };
}

/** A record after a cache write of `view` over `current` (null: a new row). */
export function cached(
  current: TargetRecord | null,
  view: TargetView,
  facts: CacheFacts,
  now: Date,
): TargetRecord {
  const edit = facts.by !== undefined;
  return {
    id: view.id,
    label: view.label,
    kind: kindOf(view),
    sinkId: view.sinkId,
    instanceId: view.instanceId,
    connectionId: view.connectionId,
    destination: { ...view.destination },
    onBridge: true,
    syncedAt: now.toISOString(),
    source: facts.source ?? current?.source ?? 'ui',
    seededAt: facts.seededAt !== undefined ? facts.seededAt : (current?.seededAt ?? null),
    editedAt: edit && current ? now.toISOString() : (current?.editedAt ?? null),
    updatedBy: edit ? (facts.by ?? null) : (current?.updatedBy ?? null),
    createdAt: current?.createdAt ?? now.toISOString(),
  };
}

/**
 * The unseeded default row the migrations leave: the placeholder bucket, no connection, never
 * synced (the API's seed writes it to the bridge).
 */
export function initialDefault(now: Date): TargetRecord {
  return {
    id: DEFAULT_TARGET_ID,
    label: 'Default',
    kind: 'internal',
    sinkId: 's3',
    instanceId: null,
    connectionId: null,
    destination: {
      bucket: 'ingest-published',
      prefix: '',
      sse: 'none',
      kmsKeyId: '',
      storageClass: '',
      layout: 'files',
    },
    onBridge: true,
    syncedAt: null,
    source: 'env',
    seededAt: null,
    editedAt: null,
    updatedBy: null,
    createdAt: now.toISOString(),
  };
}

export const byDefaultThenLabel = (a: TargetChoice, b: TargetChoice): number =>
  Number(b.id === DEFAULT_TARGET_ID) - Number(a.id === DEFAULT_TARGET_ID) ||
  a.label.localeCompare(b.label);

/**
 * The target a job reads back from (Results, the zip, read keys, the graph's copy): the first in
 * the recipe's list that is an S3 target with the `files` layout. Undefined when there is none
 * (validation refuses such a recipe).
 */
export function primaryTargetOf(
  ids: readonly string[],
  targets: readonly Pick<TargetRecord, 'id' | 'sinkId' | 'destination'>[],
): string | undefined {
  return ids.find((id) => {
    const t = targets.find((x) => x.id === id);
    return t !== undefined && s3PlaceOf(t)?.layout === 'files';
  });
}

export interface PublishedDefinition {
  id: string;
  version: number;
  definition: { delivery?: { publishTo?: string | string[] } };
}

/** The facts the memory repo cannot see (tests stage them). */
export interface TargetFactSource {
  publishedDefinitions(): Promise<PublishedDefinition[]>;
  deliveredCount(targetId: string): Promise<number>;
  consumerCount(targetId: string): Promise<number>;
  /** Queued or running withdraw jobs whose params name the target. */
  pendingJobCount(targetId: string): Promise<number>;
}

export class MemoryPublishTargetRepo implements PublishTargetRepo {
  private readonly targets = new Map<string, TargetRecord>();
  /**
   * Ids removed, or made inert by a copy restore: the row stays (the id is taken, so the bridge
   * never sees it reused), nothing else sees it.
   */
  private readonly inert = new Set<string>();
  private readonly legacy = new Map<string, LegacyKeys>();
  private counter = 0;

  constructor(
    private readonly facts: TargetFactSource = {
      publishedDefinitions: async () => [],
      deliveredCount: async () => 0,
      consumerCount: async () => 0,
      pendingJobCount: async () => 0,
    },
  ) {
    this.targets.set(DEFAULT_TARGET_ID, initialDefault(new Date()));
  }

  async list(): Promise<PublishTargetView[]> {
    const out: PublishTargetView[] = [];
    for (const r of this.live()) out.push(toView(r, await this.usage(r.id)));
    return out;
  }

  async get(id: string): Promise<TargetRecord | null> {
    if (this.inert.has(id)) return null;
    const r = this.targets.get(id);
    return r ? structuredClone(r) : null;
  }

  /** What a removal, or a copy restore to a dropped external target, does (`inert_at` in Postgres). */
  makeInert(id: string): void {
    if (!this.targets.has(id)) return;
    this.inert.add(id);
    this.counter += 1;
  }

  /** What the migration leaves in `publish_target_legacy_keys`. */
  putLegacyKeys(keys: LegacyKeys): void {
    this.legacy.set(keys.id, structuredClone(keys));
  }

  private live(): TargetRecord[] {
    return [...this.targets.values()].filter((r) => !this.inert.has(r.id));
  }

  async cache(view: TargetView, facts: CacheFacts = {}): Promise<TargetRecord> {
    const next = cached(this.targets.get(view.id) ?? null, view, facts, new Date());
    this.targets.set(view.id, next);
    this.counter += 1;
    return structuredClone(next);
  }

  async markMissing(ids: string[]): Promise<void> {
    for (const id of ids) {
      const r = this.targets.get(id);
      if (r) this.targets.set(id, { ...r, onBridge: false });
    }
    if (ids.length) this.counter += 1;
  }

  async cachedIds(): Promise<{ id: string; live: boolean }[]> {
    return [...this.targets.keys()].map((id) => ({ id, live: !this.inert.has(id) }));
  }

  async remove(
    id: string,
    onBridge?: () => Promise<boolean>,
  ): Promise<'deleted' | 'missing' | 'default' | 'seeded' | 'in_use' | 'refused'> {
    if (id === DEFAULT_TARGET_ID) return 'default';
    const r = await this.get(id);
    if (!r) return 'missing';
    if (r.kind === 'rdf') return 'seeded';
    if (targetInUse(await this.usage(id))) return 'in_use';
    if (onBridge && !(await onBridge())) return 'refused';
    this.legacy.delete(id);
    this.makeInert(id);
    return 'deleted';
  }

  async usage(id: string): Promise<TargetUsage> {
    const published = (await this.facts.publishedDefinitions()).filter((p) =>
      publishTargetsOf(p.definition).includes(id),
    );
    return {
      publishedVersions: published.length,
      documentTypes: [...new Set(published.map((p) => p.id))].sort(),
      deliveredOutputs: await this.facts.deliveredCount(id),
      consumers: await this.facts.consumerCount(id),
      pendingJobs: await this.facts.pendingJobCount(id),
    };
  }

  async choices(): Promise<TargetChoice[]> {
    return this.live()
      .flatMap((r): TargetChoice[] => {
        const place = s3PlaceOf(r);
        if (r.kind === 'sink') {
          return [
            {
              id: r.id,
              label: r.label,
              kind: r.kind,
              bucket: '',
              prefix: '',
              layout: null,
              sinkName: null,
            },
          ];
        }
        return place && (r.kind === 'internal' || r.kind === 'external')
          ? [{ id: r.id, label: r.label, kind: r.kind, ...place, sinkName: null }]
          : [];
      })
      .sort(byDefaultThenLabel);
  }

  async version(): Promise<number> {
    return this.counter;
  }

  async legacyKeys(): Promise<LegacyKeys[]> {
    return [...this.legacy.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((k) => structuredClone(k));
  }

  async dropLegacyKeys(id: string): Promise<void> {
    this.legacy.delete(id);
  }

  async chooseLegacyConnection(id: string, connectionId: string): Promise<void> {
    const k = this.legacy.get(id);
    if (k) this.legacy.set(id, { ...k, connectionId });
  }

  async connectionOf(id: string): Promise<string | null> {
    return (await this.get(id))?.connectionId ?? null;
  }
}
