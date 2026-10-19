import {
  choiceNames,
  isOffered,
  modelRefProblem,
  pickedChoice,
  pickerChoices,
  TemplateSchema,
  type DataPolicy,
  type ModelChoice,
  type Template,
} from '@ih/shared';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { Definition, DefinitionSummary } from '../specs/spec-registry.js';
import type { TemplateRecord } from './repo.js';
import { semanticsIssues } from './semantics.js';

export const TemplateIssueSchema = z.object({
  path: z.string().describe('Where in the definition, e.g. `outputs.fields.0.type`.'),
  message: z.string(),
  /** Absent: an error, which blocks publishing. A warning is shown and never blocks. */
  severity: z.literal('warning').optional(),
});
export type TemplateIssue = z.infer<typeof TemplateIssueSchema>;

/** The issues that block publishing (warnings do not). */
export const blockingIssues = (issues: TemplateIssue[]) =>
  issues.filter((i) => i.severity !== 'warning');

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
            message: `step "${step.id}": custom prompt files are not supported for recipes stored in the database; use instructions`,
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

/** The model choices people may pick (ADR 0010, phase 4c): offered ones, default first. */
export async function modelChoices(deps: Pick<AppDeps, 'repo' | 'llm'>): Promise<ModelChoice[]> {
  const [models, choices, settings, endpoints] = await Promise.all([
    deps.repo.listModels(),
    deps.llm.listChoices(),
    deps.llm.getSettings(),
    deps.llm.listEndpoints(),
  ]);
  const offered = new Set(models.filter(isOffered).map((m) => m.ref));
  return pickerChoices(choices, settings, endpoints, offered);
}

/** Why a project may not run with a pick (a choice id or `default`), or null when it may. */
export function choiceProblem(
  name: string,
  choices: readonly ModelChoice[],
  dataPolicy: DataPolicy,
): string | null {
  const choice = pickedChoice(name, choices);
  if (!choice) return `unknown model choice ${name}`;
  return dataPolicy === 'local' && choice.location === 'external'
    ? `${choice.label} runs on an external endpoint: this project is local-only`
    : null;
}

/**
 * `validateTemplate` plus the models its steps name: only models offered on their endpoint run
 * (ADR 0010), so a step naming another one is an issue (and blocks publishing). An alias the
 * database does not define is left to the worker. A draft's steps and its document type model
 * name model choices (phase 4c): an `endpoint/model` ref there is an issue too, while published
 * versions keep running theirs.
 */
export async function templateIssues(
  deps: Pick<AppDeps, 'repo' | 'llm' | 'ontologies' | 'targets'>,
  definition: unknown,
  { draft }: { draft: boolean },
): Promise<TemplateIssue[]> {
  const issues = validateTemplate(definition);
  const parsed = TemplateSchema.safeParse(definition);
  if (!parsed.success) return issues;
  const { offered, aliases } = await runnableModels(deps);
  const problemOf = (model: string) =>
    draft && model.includes('/')
      ? `pick a model choice instead of the model ${model}`
      : modelRefProblem(model, offered, aliases, { unknownAliases: 'allow' });
  // The document type's model, which steps naming none inherit, is checked once, here.
  const typeModel = parsed.data.model;
  const typeProblem = typeModel === undefined ? null : problemOf(typeModel);
  const modelIssues = parsed.data.pipeline.flatMap((step, i) => {
    if (step.type !== 'extract' || step.model === 'default') return [];
    const problem = problemOf(step.model);
    return problem
      ? [{ path: `pipeline.${i}.model`, message: `step "${step.id}": ${problem}` }]
      : [];
  });
  // A recipe from another deployment keeps its target id; until one exists here it cannot publish.
  const publishTo = parsed.data.delivery?.publishTo;
  const named = publishTo === undefined ? null : await deps.targets.get(publishTo);
  const targetIssues =
    publishTo === undefined
      ? []
      : !named
        ? [
            {
              path: 'delivery.publishTo',
              message: `no publishing target ${publishTo} on this deployment`,
            },
          ]
        : named.kind === 'rdf'
          ? [
              {
                path: 'delivery.publishTo',
                message: `${publishTo} is a triple store: name an S3 target`,
              },
            ]
          : [];
  return [
    ...issues,
    ...(typeProblem ? [{ path: 'model', message: typeProblem }] : []),
    ...modelIssues,
    ...targetIssues,
    ...(await semanticsIssues(deps.ontologies, parsed.data)),
  ];
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

/**
 * Document types offered for upload: published database recipes + file definitions. Retired
 * types are left out, or with `includeRetired` listed with their `retired` (old jobs and results
 * still name them).
 */
export async function listDefinitions(
  deps: AppDeps,
  { includeRetired = false }: { includeRetired?: boolean } = {},
): Promise<DefinitionSummary[]> {
  const [all, retirements] = await Promise.all([
    deps.templates.list(),
    deps.templates.listRetirements(),
  ]);
  const records = all.filter((r) => r.status === 'published');
  const fromDb: DefinitionSummary[] = records.map((r) => ({
    id: r.id,
    version: r.version,
    title: String(r.definition.name ?? r.id),
    description: r.definition.description as string | undefined,
    ...(typeof r.definition.model === 'string' ? { model: r.definition.model } : {}),
    kind: 'template',
  }));
  const seen = new Set(fromDb.map((d) => `${d.id}@${d.version}`));
  const files = deps.specs.list().filter((d) => !seen.has(`${d.id}@${d.version}`));
  return [...fromDb, ...files]
    .flatMap((d) => {
      const retired = retirements.get(d.id);
      if (!retired) return [d];
      return includeRetired ? [{ ...d, retired }] : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
}
