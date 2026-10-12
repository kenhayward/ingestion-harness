import type { TemplateRecord, TemplateRepo } from './repo.js';

/** v1 draft of a new document type, to fill in with the editor. */
export function skeleton(id: string, name: string): Record<string, unknown> {
  return {
    id,
    version: 1,
    name,
    document: { ocr: 'auto', sections: [{ id: 'all', anchor: '\\A' }] },
    outputs: { fields: [], tables: [] },
    pipeline: [],
    review: { required: 'on_warnings' },
  };
}

/** Definition with id/version pinned to the record it is stored under. */
export const pinned = (definition: Record<string, unknown>, id: string, version: number) => ({
  ...definition,
  id,
  version,
});

/** The next version as a draft copied from `from` (default: the latest version). */
export async function createNextDraft(
  repo: TemplateRepo,
  id: string,
  from?: number,
): Promise<TemplateRecord | 'not-found' | 'draft-exists'> {
  const versions = (await repo.list()).filter((r) => r.id === id);
  if (!versions.length) return 'not-found';
  if (versions.some((v) => v.status === 'draft')) return 'draft-exists';
  const source = from ? versions.find((v) => v.version === from) : versions.at(-1);
  if (!source) return 'not-found';
  const next = versions.at(-1)!.version + 1;
  return repo.create(id, next, pinned(source.definition, id, next), 'draft');
}
