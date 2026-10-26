import { createHash } from 'node:crypto';

/**
 * What a delivery is about: one source document under one recipe version. Every delivery of the
 * same three carries the same key, so a sink can replace what it wrote before.
 */
export function idempotencyKey(
  sourceSha256: string,
  recipeId: string,
  recipeVersion: number,
): string {
  return createHash('sha256')
    .update(`${sourceSha256}\n${recipeId}\n${recipeVersion}`)
    .digest('hex');
}

/**
 * What a graph package is about: one graph name at one version (an ontology version, or a rebuilt
 * or reminted graph), so delivering it again is recognised as the same thing.
 */
export function graphIdempotencyKey(graphName: string, version: number): string {
  return createHash('sha256').update(`graph\n${graphName}\n${version}`).digest('hex');
}

/**
 * What a decomposition delivery is about: one source, the document it replaces (null: a new one),
 * the decomposer version, and the run's token (null: none). The worker computes the same key and
 * picks the token (`decompose/deliver._run_token`, spec §9): a force-load's, a detach's for a
 * create after a detach, or, for an update, the digest of the component versions it expects.
 * The parameter keeps its first name, `forceBatchId`.
 */
export function decompositionIdempotencyKey(
  sourceSha256: string,
  persistentId: string | null,
  decomposerVersion: number,
  forceBatchId: string | null,
): string {
  const parts = [
    'decomposition',
    sourceSha256,
    persistentId ?? '',
    String(decomposerVersion),
    forceBatchId ?? '',
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
