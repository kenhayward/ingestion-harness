import {
  DEFAULT_TARGET_ID,
  TRIPLE_STORE_TARGET_ID,
  deliveryPublishTo,
  targetInUse,
  type PublishTargetView,
  type TargetChoice,
  type TargetUsage,
} from '@ih/shared';
import { seedDifferences, type DefaultSeed, type RdfSeed } from './seed.js';

/**
 * A stored target: the view's fields plus what is never sent out. The credential columns are
 * what a target held before its keys moved to the delivery bridge (they are read once, by the
 * move, and the ciphertext is then dropped); new targets name a bridge connection instead.
 */
export interface TargetRecord extends Omit<PublishTargetView, 'usage' | 'connection'> {
  /** S3: an endpoint from before the bridge. The triple store: its URL. */
  endpoint: string | null;
  region: string | null;
  /** S3: a key id from before the bridge. The triple store: its writer's user name (not secret). */
  accessKeyId: string | null;
  forcePathStyle: boolean;
  secretKeyEnc: string | null;
  accessKeyEnv: string | null;
  secretKeyEnv: string | null;
  seededAt: string | null;
  /** When its keys moved to the bridge (then its ciphertext is gone). */
  movedToBridgeAt: string | null;
}

/** What a create stores; the route has made the id and encrypted the secret. */
export interface NewTarget {
  id: string;
  label: string;
  kind: 'internal' | 'external';
  bucket: string;
  prefix: string;
  endpoint: string | null;
  region: string | null;
  accessKeyId: string | null;
  secretKeyEnc: string | null;
  accessKeyEnv: string | null;
  secretKeyEnv: string | null;
  forcePathStyle: boolean;
  sse: 'none' | 'AES256' | 'aws:kms';
  kmsKeyId: string | null;
  storageClass: string | null;
  /** The bridge connection an external target delivers with. */
  connectionId?: string | null;
}

/** Fields left out are kept; `null` clears an optional one. `kind` and `id` never change. */
export type TargetPatch = Partial<Omit<NewTarget, 'id' | 'kind'>>;

export type SeedOutcome = 'seeded' | 'kept' | 'differs';

export interface PublishTargetRepo {
  list(): Promise<PublishTargetView[]>;
  get(id: string): Promise<TargetRecord | null>;
  create(input: NewTarget, by: string | null): Promise<PublishTargetView | 'exists'>;
  update(id: string, patch: TargetPatch, by: string | null): Promise<PublishTargetView | null>;
  /** `seeded`: the triple store target, which comes from `.env` and is never removed. */
  remove(id: string): Promise<'deleted' | 'missing' | 'default' | 'seeded' | 'in_use'>;
  usage(id: string): Promise<TargetUsage>;
  /** What a recipe's picker offers: the default first, then by label. */
  choices(): Promise<TargetChoice[]>;
  /** Moves on every write, so readers rebuild their stores. */
  version(): Promise<number>;
  /** Writes the default from `.env` once (while `seeded_at` is null); never overwrites after. */
  seedDefault(seed: DefaultSeed): Promise<SeedOutcome>;
  /** Writes the triple store target from `.env` once; never overwrites after. */
  seedRdf(seed: RdfSeed): Promise<SeedOutcome>;
  /** Its keys are now the bridge's connection `connectionId`: the ciphertext is dropped. */
  markMoved(id: string, connectionId: string): Promise<void>;
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

/** The view of a record: no credential, and the connection as the route finds it on the bridge. */
export function toView(r: TargetRecord, usage: TargetUsage): PublishTargetView {
  return {
    id: r.id,
    label: r.label,
    kind: r.kind,
    bucket: r.bucket,
    prefix: r.prefix,
    endpoint: r.kind === 'rdf' ? r.endpoint : null,
    connectionId: r.connectionId,
    connection: null,
    sse: r.sse,
    kmsKeyId: r.kmsKeyId,
    storageClass: r.storageClass,
    source: r.source,
    editedAt: r.editedAt,
    updatedBy: r.updatedBy,
    createdAt: r.createdAt,
    usage,
  };
}

export function recordFrom(input: NewTarget, by: string | null, now: Date): TargetRecord {
  return {
    ...input,
    source: 'ui',
    seededAt: null,
    connectionId: input.connectionId ?? null,
    movedToBridgeAt: null,
    editedAt: null,
    updatedBy: by,
    createdAt: now.toISOString(),
  };
}

/**
 * The record after a patch. Stored credentials replace the environment names they were read
 * from (unless the patch names those too), so a target never has both.
 */
export function patched(
  r: TargetRecord,
  patch: TargetPatch,
  by: string | null,
  now: Date,
): TargetRecord {
  const next: TargetRecord = { ...r };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
  }
  if (patch.accessKeyId != null && patch.accessKeyEnv === undefined) next.accessKeyEnv = null;
  if (patch.secretKeyEnc != null && patch.secretKeyEnv === undefined) next.secretKeyEnv = null;
  next.editedAt = now.toISOString();
  next.updatedBy = by;
  return next;
}

/** The default as the environment describes it. */
export function seeded(r: TargetRecord, seed: DefaultSeed, now: Date): TargetRecord {
  return {
    ...r,
    ...seed,
    source: 'env',
    seededAt: now.toISOString(),
    secretKeyEnc: null,
    accessKeyId: null,
  };
}

/** The triple store target as `.env` describes it. */
export function rdfRecord(seed: RdfSeed, now: Date): TargetRecord {
  return {
    id: TRIPLE_STORE_TARGET_ID,
    label: 'Triple store',
    kind: 'rdf',
    bucket: seed.dataset,
    prefix: '',
    endpoint: seed.endpoint,
    region: null,
    accessKeyId: seed.user,
    secretKeyEnc: null,
    accessKeyEnv: null,
    secretKeyEnv: null,
    forcePathStyle: false,
    sse: 'none',
    kmsKeyId: null,
    storageClass: null,
    source: 'env',
    seededAt: now.toISOString(),
    editedAt: null,
    updatedBy: null,
    createdAt: now.toISOString(),
    connectionId: TRIPLE_STORE_TARGET_ID,
    movedToBridgeAt: null,
  };
}

/** Whether the stored triple store target still matches `.env` (it is never overwritten). */
export function rdfSeedDiffers(r: TargetRecord, seed: RdfSeed): boolean {
  return r.endpoint !== seed.endpoint || r.bucket !== seed.dataset || r.accessKeyId !== seed.user;
}

/** The unseeded default row the migration inserts. */
export function initialDefault(now: Date): TargetRecord {
  return {
    id: DEFAULT_TARGET_ID,
    label: 'Default',
    kind: 'internal',
    bucket: 'ingest-published',
    prefix: '',
    endpoint: null,
    region: null,
    accessKeyId: null,
    secretKeyEnc: null,
    accessKeyEnv: null,
    secretKeyEnv: null,
    forcePathStyle: false,
    sse: 'none',
    kmsKeyId: null,
    storageClass: null,
    source: 'env',
    seededAt: null,
    editedAt: null,
    updatedBy: null,
    createdAt: now.toISOString(),
    connectionId: null,
    movedToBridgeAt: null,
  };
}

export const byDefaultThenLabel = (a: TargetChoice, b: TargetChoice): number =>
  Number(b.id === DEFAULT_TARGET_ID) - Number(a.id === DEFAULT_TARGET_ID) ||
  a.label.localeCompare(b.label);

export interface PublishedDefinition {
  id: string;
  version: number;
  definition: { delivery?: { publishTo?: string } };
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
  /** Ids a copy restore made inert: the row stays (the id is taken), nothing else sees it. */
  private readonly inert = new Set<string>();
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
    return this.inert.has(id) ? null : (this.targets.get(id) ?? null);
  }

  /** What a copy restore does to a dropped external target (`inert_at` in Postgres). */
  makeInert(id: string): void {
    if (!this.targets.has(id)) return;
    this.inert.add(id);
    this.counter += 1;
  }

  private live(): TargetRecord[] {
    return [...this.targets.values()].filter((r) => !this.inert.has(r.id));
  }

  async create(input: NewTarget, by: string | null): Promise<PublishTargetView | 'exists'> {
    if (this.targets.has(input.id)) return 'exists';
    const r = recordFrom(input, by, new Date());
    this.targets.set(r.id, r);
    this.counter += 1;
    return toView(r, await this.usage(r.id));
  }

  async update(
    id: string,
    patch: TargetPatch,
    by: string | null,
  ): Promise<PublishTargetView | null> {
    const r = await this.get(id);
    if (!r) return null;
    const next = patched(r, patch, by, new Date());
    this.targets.set(id, next);
    this.counter += 1;
    return toView(next, await this.usage(id));
  }

  async remove(id: string): Promise<'deleted' | 'missing' | 'default' | 'seeded' | 'in_use'> {
    if (id === DEFAULT_TARGET_ID) return 'default';
    const r = await this.get(id);
    if (!r) return 'missing';
    if (r.kind === 'rdf') return 'seeded';
    if (targetInUse(await this.usage(id))) return 'in_use';
    this.targets.delete(id);
    this.counter += 1;
    return 'deleted';
  }

  async usage(id: string): Promise<TargetUsage> {
    const published = (await this.facts.publishedDefinitions()).filter(
      (p) => deliveryPublishTo(p.definition) === id,
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
      .flatMap(({ id, label, kind, bucket }) =>
        kind === 'rdf' ? [] : [{ id, label, kind, bucket }],
      )
      .sort(byDefaultThenLabel);
  }

  async version(): Promise<number> {
    return this.counter;
  }

  async seedDefault(seed: DefaultSeed): Promise<SeedOutcome> {
    const r = this.targets.get(DEFAULT_TARGET_ID)!;
    if (r.seededAt === null) {
      this.targets.set(DEFAULT_TARGET_ID, seeded(r, seed, new Date()));
      this.counter += 1;
      return 'seeded';
    }
    return seedDifferences(r, seed).length > 0 ? 'differs' : 'kept';
  }

  async seedRdf(seed: RdfSeed): Promise<SeedOutcome> {
    const r = this.targets.get(TRIPLE_STORE_TARGET_ID);
    if (!r) {
      this.targets.set(TRIPLE_STORE_TARGET_ID, rdfRecord(seed, new Date()));
      this.counter += 1;
      return 'seeded';
    }
    return rdfSeedDiffers(r, seed) ? 'differs' : 'kept';
  }

  async markMoved(id: string, connectionId: string): Promise<void> {
    const r = this.targets.get(id);
    if (!r) return;
    this.targets.set(id, {
      ...r,
      connectionId,
      secretKeyEnc: null,
      movedToBridgeAt: new Date().toISOString(),
    });
    this.counter += 1;
  }

  async connectionOf(id: string): Promise<string | null> {
    return (await this.get(id))?.connectionId ?? null;
  }
}
