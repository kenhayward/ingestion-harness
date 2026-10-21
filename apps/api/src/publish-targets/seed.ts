import type { ConnectionSummary, TargetView } from '@ih/bridge-contract';
import { DEFAULT_TARGET_ID, TRIPLE_STORE_TARGET_ID, type TargetKind } from '@ih/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { BridgeApi } from '../bridge/client.js';
import type { Config } from '../config.js';
import {
  INTERNAL_CONNECTION_ID,
  kindOf,
  RDF_SINK_ID,
  s3Destination,
  s3PlaceOf,
  S3_SINK_ID,
} from './place.js';
import type { PublishTargetRepo, SeedOutcome } from './repo.js';

/** The default target as `.env` describes it (held in step with the worker by a shared fixture). */
export interface DefaultSeed {
  kind: TargetKind;
  bucket: string;
  prefix: string;
  endpoint: string | null;
  region: string | null;
  accessKeyEnv: string | null;
  secretKeyEnv: string | null;
  forcePathStyle: boolean;
}

/**
 * The `TARGET_S3_*` settings as a target. Internal (the deployment's own SeaweedFS, keys from the
 * `S3_*` connection) when the target's endpoint and keys are blank or equal to `S3_*`; otherwise
 * external, reading its keys from the same variables as before: a blank target key falls back to
 * `S3_*`, so the identity that writes does not change on upgrade. Path style because today's
 * client is path style.
 */
export function defaultSeed(c: Config): DefaultSeed {
  const sameEndpoint = c.TARGET_S3_ENDPOINT === undefined || c.TARGET_S3_ENDPOINT === c.S3_ENDPOINT;
  const ownAccess =
    c.TARGET_S3_ACCESS_KEY !== undefined && c.TARGET_S3_ACCESS_KEY !== c.S3_ACCESS_KEY;
  const ownSecret =
    c.TARGET_S3_SECRET_KEY !== undefined && c.TARGET_S3_SECRET_KEY !== c.S3_SECRET_KEY;
  const bucket = c.TARGET_S3_BUCKET;
  // Verbatim, never normalised: `ingest` has always meant keys like `ingestletter/…`, and
  // existing graph copies and data-lake grants sit under it (prefixes admins enter are normalised).
  const prefix = c.TARGET_S3_PREFIX;
  if (sameEndpoint && !ownAccess && !ownSecret) {
    return {
      kind: 'internal',
      bucket,
      prefix,
      endpoint: null,
      region: null,
      accessKeyEnv: null,
      secretKeyEnv: null,
      forcePathStyle: true,
    };
  }
  return {
    kind: 'external',
    bucket,
    prefix,
    endpoint: c.TARGET_S3_ENDPOINT ?? c.S3_ENDPOINT,
    region: c.TARGET_S3_REGION ?? c.S3_REGION,
    accessKeyEnv: c.TARGET_S3_ACCESS_KEY !== undefined ? 'TARGET_S3_ACCESS_KEY' : 'S3_ACCESS_KEY',
    secretKeyEnv: c.TARGET_S3_SECRET_KEY !== undefined ? 'TARGET_S3_SECRET_KEY' : 'S3_SECRET_KEY',
    forcePathStyle: true,
  };
}

const COMPARED = ['kind', 'endpoint', 'bucket', 'prefix'] as const;

/** The fields of the stored default that differ from what `.env` now says (it is never overwritten). */
export function seedDifferences(
  stored: Pick<DefaultSeed, Exclude<(typeof COMPARED)[number], 'kind'>> & { kind: string },
  seed: DefaultSeed,
): string[] {
  return COMPARED.filter((k) => stored[k] !== seed[k]);
}

/** The triple store target as `.env` describes it (held in step with the worker by a fixture). */
export interface RdfSeed {
  endpoint: string;
  dataset: string;
  user: string;
}

/** `RDF_ENDPOINT` as the triple store target; null (no target) when it is blank. */
export function rdfSeed(c: Config): RdfSeed | null {
  if (!c.RDF_ENDPOINT) return null;
  return { endpoint: c.RDF_ENDPOINT, dataset: c.RDF_DATASET, user: c.RDF_USER };
}

/** What a seed step needs: the cache, the bridge, and somewhere to say what it did. */
export interface SeedDeps {
  targets: PublishTargetRepo;
  bridge: BridgeApi;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}

/** The connection an env-keyed default reads its keys with (the move's id for it). */
export const DEFAULT_ENV_CONNECTION_ID = `target-${DEFAULT_TARGET_ID}`;

/**
 * The default from `.env`, written to the bridge only while the bridge has no `default` or CT
 * Studio never seeded it; the bridge's answer is then cached (source `env`, seeded now).
 * Otherwise nothing is written, and a `.env` that moved since is logged. An internal default
 * delivers with the built-in connection; an external one with the env connection
 * `target-default`, which reads the same variables as before in the bridge's container.
 */
export async function seedDefault(deps: SeedDeps, seed: DefaultSeed): Promise<SeedOutcome> {
  const current = await deps.targets.get(DEFAULT_TARGET_ID);
  const held = (await deps.bridge.listTargets()).find((t) => t.id === DEFAULT_TARGET_ID);
  if (held && current && current.seededAt !== null) {
    const place = s3PlaceOf(held);
    const kind = kindOf(held);
    const endpoint =
      kind === 'external' && held.connectionId
        ? ((await deps.bridge.listConnections('shared')).find((c) => c.id === held.connectionId)
            ?.fields.endpoint ?? null)
        : null;
    const moved = seedDifferences(
      { kind, endpoint, bucket: place?.bucket ?? '', prefix: place?.prefix ?? '' },
      seed,
    );
    if (moved.length === 0) return 'kept';
    deps.log.warn(
      `publishing target default differs from .env (${moved.join(', ')}): .env is ignored now`,
    );
    return 'differs';
  }
  let connectionId = INTERNAL_CONNECTION_ID;
  if (seed.kind === 'external') {
    connectionId = DEFAULT_ENV_CONNECTION_ID;
    const fields: Record<string, string> = {};
    if (seed.endpoint) fields.endpoint = seed.endpoint;
    if (seed.region) fields.region = seed.region;
    if (seed.accessKeyEnv) fields.accessKeyIdEnv = seed.accessKeyEnv;
    fields.forcePathStyle = String(seed.forcePathStyle);
    await deps.bridge.putSharedConnection({
      id: connectionId,
      name: current?.label ?? 'Default',
      fields,
      secret: null,
      secretEnv: seed.secretKeyEnv,
    });
  }
  const view = await deps.bridge.putTarget(DEFAULT_TARGET_ID, {
    label: current?.label ?? 'Default',
    sinkId: S3_SINK_ID,
    instanceId: null,
    connectionId,
    destination: s3Destination({
      bucket: seed.bucket,
      prefix: seed.prefix,
      sse: 'none',
      kmsKeyId: null,
      storageClass: null,
      layout: 'files',
    }),
  });
  await deps.targets.cache(view, { source: 'env', seededAt: new Date().toISOString() });
  deps.log.info('publishing target default seeded from .env');
  return 'seeded';
}

/**
 * The triple store's connection, made from `.env` when the bridge has none yet: the endpoint and
 * the writer's user, its password read from the bridge's own RDF_PASSWORD. One the bridge already
 * has is left alone, so a password an admin stored on the connections page stays. Answers the
 * bridge's summary of it (null when it was just made, until the next list).
 */
export async function ensureRdfConnection(
  bridge: BridgeApi,
  seed: RdfSeed,
): Promise<ConnectionSummary | null> {
  const existing = (await bridge.listConnections('shared')).find(
    (c) => c.id === TRIPLE_STORE_TARGET_ID,
  );
  if (existing) return existing;
  await bridge.putSharedConnection({
    id: TRIPLE_STORE_TARGET_ID,
    name: 'Triple store',
    sinkId: RDF_SINK_ID,
    fields: { endpoint: seed.endpoint, user: seed.user },
    secret: null,
    secretEnv: 'RDF_PASSWORD',
  });
  return null;
}

/**
 * Whether the triple store on the bridge still matches `.env` (it is never overwritten): the
 * target's dataset, and its connection's endpoint and user as the bridge's summary reports them
 * (the dataset alone when the connection is unknown).
 */
export function rdfSeedDiffers(
  target: Pick<TargetView, 'sinkId' | 'destination'>,
  connection: ConnectionSummary | null,
  seed: RdfSeed,
): boolean {
  if (target.sinkId !== RDF_SINK_ID || target.destination.dataset !== seed.dataset) return true;
  if (!connection) return false;
  return connection.fields.endpoint !== seed.endpoint || connection.fields.user !== seed.user;
}

/**
 * The triple store target from RDF_ENDPOINT: its connection made once, then the target written
 * to the bridge only while the bridge has none or CT Studio never seeded it, and cached.
 */
export async function seedRdf(deps: SeedDeps, seed: RdfSeed): Promise<SeedOutcome> {
  const connection = await ensureRdfConnection(deps.bridge, seed);
  const current = await deps.targets.get(TRIPLE_STORE_TARGET_ID);
  const held = (await deps.bridge.listTargets()).find((t) => t.id === TRIPLE_STORE_TARGET_ID);
  if (held && current && current.seededAt !== null) {
    if (!rdfSeedDiffers(held, connection, seed)) return 'kept';
    deps.log.warn(
      'the triple store target differs from RDF_ENDPOINT/RDF_DATASET/RDF_USER: .env is ignored now',
    );
    return 'differs';
  }
  // A row code from before the merge left (an S3 sink, no destination) keeps only its label.
  const label = current?.kind === 'rdf' ? current.label : 'Triple store';
  const view = await deps.bridge.putTarget(TRIPLE_STORE_TARGET_ID, {
    label,
    sinkId: RDF_SINK_ID,
    instanceId: null,
    connectionId: TRIPLE_STORE_TARGET_ID,
    destination: { dataset: seed.dataset },
  });
  await deps.targets.cache(view, { source: 'env', seededAt: new Date().toISOString() });
  deps.log.info('triple store target seeded from RDF_ENDPOINT');
  return 'seeded';
}
