import type { TargetView } from '@ih/bridge-contract';
import { SSE_MODES, type PublishTargetKind, type TargetLayout } from '@ih/shared';

/** The bridge's built-in connection: the deployment's own S3, for internal targets. */
export const INTERNAL_CONNECTION_ID = 'internal';
export const S3_SINK_ID = 's3';
export const RDF_SINK_ID = 'rdf';

/** A target as far as where it writes goes: its sink and that sink's destination. */
export interface Placed {
  sinkId: string;
  destination: Record<string, string>;
}

/** Where an S3 target writes. */
export interface S3Place {
  bucket: string;
  prefix: string;
  layout: TargetLayout;
}

/**
 * Where an S3 target writes (a blank layout is `files`); null for any other sink. The same rule
 * as the SQL function `target_s3_place`.
 */
export function s3PlaceOf(t: Placed): S3Place | null {
  if (t.sinkId !== S3_SINK_ID) return null;
  return {
    bucket: t.destination.bucket ?? '',
    prefix: t.destination.prefix ?? '',
    layout: t.destination.layout === 'package' ? 'package' : 'files',
  };
}

/** An S3 target's options (encryption, KMS key, storage class); null for any other sink. */
export function s3OptionsOf(t: Placed): {
  sse: (typeof SSE_MODES)[number];
  kmsKeyId: string | null;
  storageClass: string | null;
} | null {
  if (t.sinkId !== S3_SINK_ID) return null;
  const sse = SSE_MODES.find((m) => m === t.destination.sse) ?? 'none';
  return {
    sse,
    kmsKeyId: t.destination.kmsKeyId || null,
    storageClass: t.destination.storageClass || null,
  };
}

/** The S3 sink's destination for these settings: all six fields, unset options blank. */
export function s3Destination(s: {
  bucket: string;
  prefix: string;
  sse: string;
  kmsKeyId: string | null;
  storageClass: string | null;
  layout: TargetLayout;
}): Record<string, string> {
  return {
    bucket: s.bucket,
    prefix: s.prefix,
    sse: s.sse,
    kmsKeyId: s.kmsKeyId ?? '',
    storageClass: s.storageClass ?? '',
    layout: s.layout,
  };
}

/**
 * CT Studio's classification of a bridge target: `rdf` for the rdf sink; `internal` for S3 on
 * the built-in connection; `external` for other S3 targets; `sink` for any other sink.
 */
export function kindOf(view: Pick<TargetView, 'sinkId' | 'connectionId'>): PublishTargetKind {
  if (view.sinkId === RDF_SINK_ID) return 'rdf';
  if (view.sinkId !== S3_SINK_ID) return 'sink';
  return view.connectionId === INTERNAL_CONNECTION_ID ? 'internal' : 'external';
}
