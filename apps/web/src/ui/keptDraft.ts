/**
 * Unsaved edits kept in this browser, so leaving a tab or page loses nothing: each screen stores
 * what the person typed under its own key (`ih.<what>.<project or recipe>…`), with the `base` it
 * was typed against (a saved version or time), and puts it back when it opens again. Kept only
 * while there is something unsaved; storage that is blocked, full or unreadable just means the
 * edits last while the screen is open, as before.
 */
export type Kept<T> = { base: string | number | null; value: T };

/** The kept edits under `key`, or null when there are none or they cannot be read. */
export function loadKept<T>(key: string, parse: (value: unknown) => T | null): Kept<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { base?: unknown; value?: unknown };
    const base = stored.base;
    if (!(base === null || typeof base === 'string' || typeof base === 'number')) return null;
    const value = parse(stored.value);
    return value === null ? null : { base, value };
  } catch {
    return null;
  }
}

/** Keeps `kept` under `key`; null forgets it (saved, discarded, or nothing left unsaved). */
export function keepDraft<T>(key: string, kept: Kept<T> | null): void {
  try {
    if (kept === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(kept));
  } catch {
    // storage blocked or full: the edits last while the screen is open
  }
}

/** Every kind of kept edit keyed by project (or by recipe id, which is the project id). */
const PROJECT_KINDS = [
  'briefDraft',
  'recipeDraft',
  'sectionsDraft',
  'surveyAnswers',
  'feedbackDraft',
  'commentDraft',
  'ontologyGuidance',
];

/** Forgets every kept edit of a project (it was reset: they describe what is gone). */
export function forgetProjectDrafts(projectId: string): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const key of keys) {
      if (
        key !== null &&
        PROJECT_KINDS.some(
          (kind) => key === `ih.${kind}.${projectId}` || key.startsWith(`ih.${kind}.${projectId}.`),
        )
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // storage blocked: nothing was kept
  }
}

/** A plain object of strings (typed answers), or null. */
export function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, v]) => typeof v === 'string')
    ? (Object.fromEntries(entries) as Record<string, string>)
    : null;
}
