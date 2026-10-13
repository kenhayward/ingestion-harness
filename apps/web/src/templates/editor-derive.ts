import type { JobSummary } from '@ih/shared';
import { plural } from './quality.js';

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Why Publish is disabled (shown as its title and next to it), or null when it can publish. */
export function publishBlocker(dirty: boolean, issues: number): string | null {
  if (dirty) return 'Save the draft before publishing';
  if (issues > 0) return `Fix ${plural(issues, 'validation issue')}`;
  return null;
}

/** Tab counts; parts an unfinished draft lacks count 0. */
export function tabCounts(def: {
  document?: { sections?: unknown };
  outputs?: { fields?: unknown; tables?: unknown };
  pipeline?: unknown;
}) {
  return {
    sections: list(def.document?.sections).length,
    fields: list(def.outputs?.fields).length,
    tables: list(def.outputs?.tables).length,
    steps: list(def.pipeline).length,
  };
}

/**
 * One line describing a pipeline step on its collapsed card; `modelName` turns a model choice's
 * id into its label.
 */
export function stepSummary(
  step: Record<string, unknown>,
  modelName: (id: string) => string = (id) => id,
): string {
  if (step.type === 'check') {
    const values = text(step.values).trim();
    const reference = text(step.reference).trim();
    return values && reference ? `${values} vs ${reference}` : 'not set up yet';
  }
  if (step.type !== 'extract') return '';
  const named = text(step.model);
  const model = named && named !== 'default' ? modelName(named) : 'default model';
  if (typeof step.table === 'string') {
    const chunk = typeof step.chunkPages === 'number' ? [`${step.chunkPages} pages per call`] : [];
    return [`Table ${step.table}`, ...chunk, model].join(' · ');
  }
  const sections = list(step.sections).map(String);
  return [
    plural(list(step.fields).length, 'field'),
    ...(sections.length ? [`reads ${sections.join(', ')}`] : []),
    model,
  ].join(' · ');
}

/** The newest test runs of a document type (regression runs belong to the Quality tab). */
export function recentTestRuns(
  jobs: readonly JobSummary[],
  templateId: string,
  n = 5,
): JobSummary[] {
  return jobs
    .filter((j) => j.test && j.specId === templateId && !j.referenceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, n);
}
