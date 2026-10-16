import { VersionLabelBodySchema, type RecipeFile } from '@ih/shared';
import type { AppDeps } from '../app.js';
import { pinned } from '../templates/drafts.js';
import { startedChange } from '../templates/changes.js';
import { TemplateConflictError, type TemplateRecord } from '../templates/repo.js';
import { githubAuthor } from './remote.js';

/** What the user must resolve before a file can be imported (a 409). */
export class ImportConflict extends Error {}

export interface ImportOptions {
  /** The document type to create or add to; default the definition's own id. */
  id?: string;
  /** A new type's name; default the definition's `name`, else the id. */
  name?: string;
  /** The commit read on GitHub; null for an uploaded file. */
  commit: string | null;
  by: string | null;
}

/**
 * Imports a CT Studio recipe file as a draft, never published: a new type becomes its v1, a type
 * that exists its next free version (refused while a draft is open). The definition takes the
 * type's id and the version it is stored under; the file's label and note are copied. The
 * file's own `importedFrom` is not kept: nothing a later push reads stores it.
 */
export async function importRecipeFile(
  deps: Pick<AppDeps, 'templates'>,
  file: RecipeFile,
  opts: ImportOptions,
): Promise<TemplateRecord> {
  const id = opts.id ?? (typeof file.definition.id === 'string' ? file.definition.id : undefined);
  if (!id) throw new ImportConflict('the file names no document type: give an id');
  const versions = (await deps.templates.list()).filter((r) => r.id === id);
  if (versions.some((r) => r.status === 'draft')) {
    throw new ImportConflict('a draft already exists; edit or delete it first');
  }
  const version = versions.reduce((n, r) => Math.max(n, r.version), 0) + 1;
  const from = `${file.instance}/${typeof file.definition.id === 'string' ? file.definition.id : id}`;
  const source = `${from} v${file.version.number}`;
  const summary =
    opts.commit === null
      ? `Imported from YAML (${source})`
      : `Imported from GitHub: ${source} @ ${opts.commit.slice(0, 7)}`;

  let definition: Record<string, unknown> = pinned(file.definition, id, version);
  if (versions.length === 0) {
    const name = opts.name ?? (typeof definition.name === 'string' ? definition.name : id);
    definition = { ...definition, name };
  }
  let record: TemplateRecord;
  try {
    record = await deps.templates.create(
      id,
      version,
      definition,
      'draft',
      startedChange(summary, opts.by, 'import'),
    );
  } catch (err) {
    if (err instanceof TemplateConflictError) throw new ImportConflict(err.message);
    throw err;
  }
  const label = VersionLabelBodySchema.safeParse({
    label: file.version.label,
    note: file.version.note,
  });
  if (label.success && (file.version.label !== null || file.version.note !== null)) {
    const by = opts.commit === null ? (opts.by ?? githubAuthor(file)) : githubAuthor(file);
    record = (await deps.templates.setLabel(id, version, label.data, by)) ?? record;
  }
  return record;
}
