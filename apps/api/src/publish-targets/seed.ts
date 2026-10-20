import type { TargetKind } from '@ih/shared';
import type { Config } from '../config.js';

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
