import { choiceNames, isOffered, modelRefProblem, TemplateSchema, type Template } from '@ih/shared';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { Definition, DefinitionSummary } from '../specs/spec-registry.js';
import type { TemplateRecord } from './repo.js';

export const TemplateIssueSchema = z.object({
  path: z.string().describe('Where in the definition, e.g. `outputs.fields.0.type`.'),
  message: z.string(),
});
export type TemplateIssue = z.infer<typeof TemplateIssueSchema>;

/**
 * Validate a template definition for database storage: the shared schema, plus no custom prompt
 * files (database templates hold no files — steps use the built-in prompt and `instructions`).
 */
export function validateTemplate(definition: unknown): TemplateIssue[] {
  const result = TemplateSchema.safeParse(definition);
  if (!result.success) {
    return result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  }
  return result.data.pipeline.flatMap((step, i) =>
    step.type === 'extract' && step.prompt && !step.prompt.startsWith('builtin/')
      ? [
          {
            path: `pipeline.${i}.prompt`,
            message: `step "${step.id}": custom prompt files are not supported for database templates; use instructions`,
          },
        ]
      : [],
  );
}

/**
 * What a user's pick may name (ADR 0010): the offered refs, and the model choices by id (plus
 * `default`, the default choice). Never the drafting or OCR model: those are the pipeline's.
 */
export async function runnableModels(deps: Pick<AppDeps, 'repo' | 'llm'>) {
  const [models, choices, settings] = await Promise.all([
    deps.repo.listModels(),
    deps.llm.listChoices(),
    deps.llm.getSettings(),
  ]);
  return {
    offered: new Set(models.filter(isOffered).map((m) => m.ref)),
    aliases: choiceNames(choices, settings),
  };
}

/**
 * `validateTemplate` plus the models its steps name: only models offered on their endpoint run
 * (ADR 0010), so a step naming another one is an issue (and blocks publishing). An alias the
 * database does not define is left to the worker.
 */
export async function templateIssues(
  deps: Pick<AppDeps, 'repo' | 'llm'>,
  definition: unknown,
): Promise<TemplateIssue[]> {
  const issues = validateTemplate(definition);
  const parsed = TemplateSchema.safeParse(definition);
  if (!parsed.success) return issues;
  const { offered, aliases } = await runnableModels(deps);
  const modelIssues = parsed.data.pipeline.flatMap((step, i) => {
    if (step.type !== 'extract') return [];
    const problem = modelRefProblem(step.model, offered, aliases, { unknownAliases: 'allow' });
    return problem
      ? [{ path: `pipeline.${i}.model`, message: `step "${step.id}": ${problem}` }]
      : [];
  });
  return [...issues, ...modelIssues];
}

/**
 * Params of a test run of a draft: a snapshot of the draft's outputs, so a reference saved from
 * the run remembers what it was checked against even after later draft edits (the worker
 * ignores `outputs`).
 */
export const draftOutputsSnapshot = (definition: Record<string, unknown>) => ({
  outputs: definition.outputs ?? null,
});

export type Resolved =
  { ok: true; definition: Definition; draft: boolean } | { ok: false; error: string };

function fromRecord(record: TemplateRecord): Resolved {
  const parsed = TemplateSchema.safeParse(record.definition);
  if (!parsed.success) return { ok: false, error: `${record.id} v${record.version} is not valid` };
  const template: Template = parsed.data;
  return {
    ok: true,
    draft: record.status === 'draft',
    definition: { kind: 'template', id: record.id, version: record.version, template },
  };
}

/**
 * Find a document type: database templates first (latest *published* when no version is
 * given), then file definitions (legacy spec.yaml, unseeded template.yaml).
 */
export async function resolveDefinition(
  deps: AppDeps,
  id: string,
  version?: number,
): Promise<Resolved | null> {
  const record =
    version === undefined
      ? await deps.templates.latestPublished(id)
      : await deps.templates.get(id, version);
  if (record) return fromRecord(record);
  const file = deps.specs.get(id, version);
  return file ? { ok: true, definition: file, draft: false } : null;
}

/** Document types offered for upload: published database templates + file definitions. */
export async function listDefinitions(deps: AppDeps): Promise<DefinitionSummary[]> {
  const records = (await deps.templates.list()).filter((r) => r.status === 'published');
  const fromDb: DefinitionSummary[] = records.map((r) => ({
    id: r.id,
    version: r.version,
    title: String(r.definition.name ?? r.id),
    description: r.definition.description as string | undefined,
    kind: 'template',
  }));
  const seen = new Set(fromDb.map((d) => `${d.id}@${d.version}`));
  const files = deps.specs.list().filter((d) => !seen.has(`${d.id}@${d.version}`));
  return [...fromDb, ...files].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
}
