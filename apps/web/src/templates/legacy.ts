import type { SpecSummary } from '@ih/shared';

/** A file-only legacy `spec.yaml` document type, as the Document types page lists it (D16). */
export interface LegacyType {
  id: string;
  /** The newest version's title. */
  title: string;
  description: string | null;
  /** Every version, oldest first. */
  versions: number[];
}

/**
 * The legacy cards: `kind: 'spec'` rows of `GET /api/specs` whose id has no database recipe.
 * `recipeIds` is every id `GET /api/templates` lists, retired ones included, so a retired recipe
 * never comes back as a legacy card. Retired rows are left out (the API leaves them out unless
 * asked with `retired=include`). Sorted by title.
 */
export function legacyTypes(
  specs: readonly SpecSummary[],
  recipeIds: ReadonlySet<string>,
): LegacyType[] {
  const byId = new Map<string, SpecSummary[]>();
  for (const s of specs) {
    if (s.kind !== 'spec' || s.retired || recipeIds.has(s.id)) continue;
    byId.set(s.id, [...(byId.get(s.id) ?? []), s]);
  }
  return [...byId.values()]
    .map((rows) => {
      const sorted = [...rows].sort((a, b) => a.version - b.version);
      const newest = sorted.at(-1)!;
      return {
        id: newest.id,
        title: newest.title,
        description: newest.description ?? null,
        versions: sorted.map((r) => r.version),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** "Version v1" or "Versions v1, v2". */
export const versionsText = (versions: readonly number[]) =>
  `${versions.length === 1 ? 'Version' : 'Versions'} ${versions.map((v) => `v${v}`).join(', ')}`;
