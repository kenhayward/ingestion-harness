import {
  DEFAULT_TARGET_ID,
  deliveryPublishTo,
  targetInUse,
  type PublishTargetView,
  type TargetChoice,
  type TargetUsage,
} from '@ih/shared';
import { seedDifferences, type DefaultSeed } from './seed.js';

/** A stored target: the view's fields plus what is never sent out (the encrypted secret). */
export interface TargetRecord extends Omit<
  PublishTargetView,
  'usage' | 'secretSet' | 'keysFromEnv'
> {
  secretKeyEnc: string | null;
  accessKeyEnv: string | null;
  secretKeyEnv: string | null;
  seededAt: string | null;
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
}

/** Fields left out are kept; `null` clears an optional one. `kind` and `id` never change. */
export type TargetPatch = Partial<Omit<NewTarget, 'id' | 'kind'>>;

export type SeedOutcome = 'seeded' | 'kept' | 'differs';

export interface PublishTargetRepo {
  list(): Promise<PublishTargetView[]>;
  get(id: string): Promise<TargetRecord | null>;
  create(input: NewTarget, by: string | null): Promise<PublishTargetView | 'exists'>;
  update(id: string, patch: TargetPatch, by: string | null): Promise<PublishTargetView | null>;
  remove(id: string): Promise<'deleted' | 'missing' | 'default' | 'in_use'>;
  usage(id: string): Promise<TargetUsage>;
  /** What a recipe's picker offers: the default first, then by label. */
  choices(): Promise<TargetChoice[]>;
  /** Moves on every write, so readers rebuild their stores. */
  version(): Promise<number>;
  /** Writes the default from `.env` once (while `seeded_at` is null); never overwrites after. */
  seedDefault(seed: DefaultSeed): Promise<SeedOutcome>;
}

export const EMPTY_USAGE: TargetUsage = {
  publishedVersions: 0,
  documentTypes: [],
  deliveredOutputs: 0,
  consumers: 0,
  pendingJobs: 0,
};

export function toView(r: TargetRecord, usage: TargetUsage): PublishTargetView {
  const { secretKeyEnc, accessKeyEnv, secretKeyEnv, seededAt: _seededAt, ...rest } = r;
  void _seededAt;
  return {
    ...rest,
    secretSet: secretKeyEnc !== null,
    keysFromEnv:
      accessKeyEnv !== null && secretKeyEnv !== null
        ? { accessKey: accessKeyEnv, secretKey: secretKeyEnv }
        : null,
    usage,
  };
}

export function recordFrom(input: NewTarget, by: string | null, now: Date): TargetRecord {
  return {
    ...input,
    source: 'ui',
    seededAt: null,
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

  async remove(id: string): Promise<'deleted' | 'missing' | 'default' | 'in_use'> {
    if (id === DEFAULT_TARGET_ID) return 'default';
    if (!(await this.get(id))) return 'missing';
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
      .map(({ id, label, kind, bucket }) => ({ id, label, kind, bucket }))
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
}
