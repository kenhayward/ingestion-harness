import { z } from 'zod';

/** Who has to act: a person (`needs_user`, never retried) or nobody yet (`retryable`). */
export const ErrorClassSchema = z.enum(['needs_user', 'retryable']);
export type ErrorClass = z.infer<typeof ErrorClassSchema>;

/** The one error shape of the producer and sink APIs. */
export const BridgeErrorSchema = z.strictObject({
  class: ErrorClassSchema,
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type BridgeError = z.infer<typeof BridgeErrorSchema>;

/** Every code the contract defines, with the class it always carries. */
export const ERROR_CODES = Object.freeze({
  credential_rejected: 'needs_user',
  credential_mfa_required: 'needs_user',
  credential_missing: 'needs_user',
  connection_missing: 'needs_user',
  name_conflict: 'needs_user',
  content_rejected: 'needs_user',
  target_missing: 'needs_user',
  pattern_unresolved: 'needs_user',
  instance_not_allowed: 'needs_user',
  unsupported_part: 'needs_user',
  not_found: 'needs_user',
  changed_in_target: 'needs_user',
  instance_unavailable: 'retryable',
  sink_unavailable: 'retryable',
  timeout: 'retryable',
  internal: 'retryable',
} as const satisfies Record<string, ErrorClass>);
export type ErrorCode = keyof typeof ERROR_CODES;

/** An error of a known code, its class taken from the code. */
export function bridgeError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): BridgeError {
  return { class: ERROR_CODES[code], code, message, ...(details ? { details } : {}) };
}

/** At most this many components in `changed_in_target` details, so they stay under 4 KB. */
const CHANGED_SHOWN = 40;

/**
 * The details of a `changed_in_target` refusal: the components changed (or missing, `actual:
 * null`) in the target, the first 40 of them, and how many `more` there are.
 */
export function changedInTargetDetails(
  changed: Array<{ id: string; expected: string; actual: string | null }>,
): Record<string, unknown> {
  const shown = changed
    .slice(0, CHANGED_SHOWN)
    .map(({ id, expected, actual }) => ({ id, expected, actual }));
  const more = changed.length - shown.length;
  return more > 0 ? { changed: shown, more } : { changed: shown };
}
