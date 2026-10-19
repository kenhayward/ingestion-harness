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
