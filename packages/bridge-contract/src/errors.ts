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
  /** Version 3: an entry from the sink's own configuration, which administration never changes. */
  locked: 'needs_user',
  /** Version 3: a caller's token does not allow the call (a write with read-only access). */
  forbidden: 'needs_user',
  /** Version 3: the sink cannot keep administration state, so it offers none. */
  not_configured: 'needs_user',
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

/** At most this many components in `changed_in_target` details. */
const CHANGED_SHOWN = 40;
/** The most UTF-8 bytes the serialised details take, well inside 4 KB. */
const CHANGED_BUDGET = 3500;
/** Ids and versions longer than this many characters are cut, with `…` appended. */
const CHANGED_TEXT = 200;

const utf8Length = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

function cut(s: string): string {
  const chars = Array.from(s.slice(0, CHANGED_TEXT * 2)); // whole code points, never half a pair
  return chars.length > CHANGED_TEXT ? `${chars.slice(0, CHANGED_TEXT).join('')}…` : s;
}

/**
 * The details of a `changed_in_target` refusal: the components changed (or missing, `actual:
 * null`) in the target, and how many `more` there are. At most 40 are listed, each id and version
 * cut to 200 characters, and no more than fit 3,500 bytes of JSON, so the details fit 4 KB.
 */
export function changedInTargetDetails(
  changed: Array<{ id: string; expected: string; actual: string | null }>,
): Record<string, unknown> {
  const detailsOf = (shown: unknown[]) => {
    const more = changed.length - shown.length;
    return more > 0 ? { changed: shown, more } : { changed: shown };
  };
  const shown: unknown[] = [];
  for (const { id, expected, actual } of changed.slice(0, CHANGED_SHOWN)) {
    const entry = {
      id: cut(id),
      expected: cut(expected),
      actual: actual === null ? null : cut(actual),
    };
    if (utf8Length(detailsOf([...shown, entry])) > CHANGED_BUDGET) break;
    shown.push(entry);
  }
  return detailsOf(shown);
}

/** The `details.reason` of a refusal whose update names a document the target no longer has. */
export const DOCUMENT_MISSING = 'document_missing';

/**
 * A sink's refusal of an update because the target no longer has that document (deleted there,
 * say): `not_found` with `details {reason: 'document_missing', persistentId}`. Only this marker
 * makes a producer treat the document as gone; any other `not_found` (no route, no sink job, a
 * delivery the bridge lost, a document found elsewhere) says nothing about the document.
 */
export function documentMissing(persistentId: string, message: string): BridgeError {
  return bridgeError('not_found', message, { reason: DOCUMENT_MISSING, persistentId });
}

/** Whether `error` is the missing-document marker for exactly `persistentId`. */
export function isDocumentMissing(
  error: Pick<BridgeError, 'code' | 'details'> | null | undefined,
  persistentId: string | null,
): boolean {
  return (
    persistentId !== null &&
    error?.code === 'not_found' &&
    error.details?.reason === DOCUMENT_MISSING &&
    error.details.persistentId === persistentId
  );
}
