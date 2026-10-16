import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import {
  definitionCanonical,
  RECIPE_FILE_FORMAT,
  RECIPE_FILE_VERSION,
  RecipeFileSchema,
  stableJson,
  type RecipeFile,
} from '@ih/shared';
import type { TemplateRecord } from '../templates/repo.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex');

/** sha256 hex of the definition without `id` and `version` (`definitionCanonical`). */
export const definitionSha256 = (definition: Record<string, unknown>) =>
  sha256(definitionCanonical(definition));

/** The sha git (and so GitHub) gives a blob: sha1 of `blob <byte length>\0<content>`. */
export const gitBlobSha = (content: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content, 'utf-8')}\0`)
    .update(content, 'utf-8')
    .digest('hex');

export interface LabelBlock {
  label: string | null;
  note: string | null;
  labelSetBy: string | null;
  labelSetAt: string | null;
}

/** A hash of the label and note (and who set them), to tell later that they changed since a push. */
export const labelSha = (l: LabelBlock) =>
  sha256(
    stableJson({
      label: l.label,
      note: l.note,
      labelSetBy: l.labelSetBy,
      labelSetAt: l.labelSetAt,
    }),
  );

export interface RecipeFileExtras {
  basedOn: number | null;
  importedFrom: RecipeFile['version']['importedFrom'];
}

/** The wrapper a published version is stored as on GitHub (keys in the documented order). */
export function recipeFileFor(
  record: TemplateRecord,
  settings: { instanceName: string },
  extras: RecipeFileExtras,
): RecipeFile {
  return {
    format: RECIPE_FILE_FORMAT,
    formatVersion: RECIPE_FILE_VERSION,
    instance: settings.instanceName,
    version: {
      number: record.version,
      status: record.status,
      label: record.label,
      note: record.note,
      labelSetBy: record.labelSetBy,
      labelSetAt: record.labelSetAt,
      publishedBy: record.publishedBy,
      publishedAt: record.publishedAt,
      basedOn: extras.basedOn,
      importedFrom: extras.importedFrom,
      definitionSha256: definitionSha256(record.definition),
    },
    definition: record.definition,
  };
}

/** The file's text; the definition reads as the YAML export does (`lineWidth` 100). */
export const recipeFileYaml = (file: RecipeFile) => toYaml(file, { lineWidth: 100 });

/** Reads a recipe file, or says why it is not one. */
export function parseRecipeFile(text: string): RecipeFile | { error: string } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { error: `not valid YAML: ${(err as Error).message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'not a CT Studio recipe file' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== RECIPE_FILE_FORMAT) return { error: 'not a CT Studio recipe file' };
  if (obj.formatVersion !== RECIPE_FILE_VERSION) {
    return { error: `formatVersion ${String(obj.formatVersion)} is not supported` };
  }
  const parsed = RecipeFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; '),
    };
  }
  return parsed.data;
}
