import type { TargetView } from '@ih/bridge-contract';
import type { TargetLayout } from '@ih/shared';
import type { CacheFacts, PublishTargetRepo, TargetRecord } from '../src/publish-targets/repo.js';

/** An S3 target as the bridge lists it (the six destination fields, blanks for unset options). */
export interface S3TargetSpec {
  id: string;
  label?: string;
  kind?: 'internal' | 'external';
  bucket?: string;
  prefix?: string;
  layout?: TargetLayout;
  sse?: 'none' | 'AES256' | 'aws:kms';
  kmsKeyId?: string | null;
  storageClass?: string | null;
  /** External targets' connection (internal ones use `internal`). */
  connectionId?: string | null;
}

export function s3View(s: S3TargetSpec): TargetView {
  const kind = s.kind ?? 'external';
  return {
    id: s.id,
    label: s.label ?? `Lake ${s.id}`,
    sinkId: 's3',
    instanceId: null,
    connectionId: kind === 'internal' ? 'internal' : (s.connectionId ?? null),
    destination: {
      bucket: s.bucket ?? 'lake',
      prefix: s.prefix ?? 'out/',
      sse: s.sse ?? 'none',
      kmsKeyId: s.kmsKeyId ?? '',
      storageClass: s.storageClass ?? '',
      layout: s.layout ?? 'files',
    },
  };
}

export const rdfView = (dataset = 'ct', label = 'Triple store'): TargetView => ({
  id: 'rdf-default',
  label,
  sinkId: 'rdf',
  instanceId: null,
  connectionId: 'rdf-default',
  destination: { dataset },
});

/** Caches an S3 target as a bridge pull or a route write would. */
export const cacheS3 = (
  repo: Pick<PublishTargetRepo, 'cache'>,
  s: S3TargetSpec,
  facts: CacheFacts = { source: 'ui' },
): Promise<TargetRecord> => repo.cache(s3View(s), facts);
