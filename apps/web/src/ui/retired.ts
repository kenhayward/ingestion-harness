import type { Retirement } from '@ih/shared';

/** Why every job-creating action of a retired document type is disabled. */
export const RETIRED_REASON =
  'This document type is retired: an admin can unretire it through the API';

/** "Retired by ken on 14 Oct 2026". */
export function retiredLine(r: Retirement): string {
  const on = new Date(r.retiredAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return r.retiredBy ? `Retired by ${r.retiredBy} on ${on}` : `Retired on ${on}`;
}

/** Unretiring is API-only (D14): the web names the route instead of offering a button. */
export const unretireHint = (id: string) =>
  `An admin can unretire it through the API: DELETE /api/specs/${id}/retirement.`;

/** "Retired by ken on 14 Oct 2026. An admin can unretire it through the API: …" (tag titles). */
export const retiredNote = (r: Retirement, id: string) => `${retiredLine(r)}. ${unretireHint(id)}`;
