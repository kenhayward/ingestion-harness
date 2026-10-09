import type { JobSummary, StepRun } from '@ih/shared';

/** Raw rows for one document type, from the repository. */
export interface MetricsData {
  jobs: JobSummary[];
  edits: { jobId: string; field: string | null; table: string | null; column: string | null }[];
  stepRuns: (StepRun & { jobId: string })[];
}

export interface TemplateMetrics {
  templateId: string;
  versions: {
    version: number;
    /** Real documents (test runs are counted separately). */
    jobs: number;
    testJobs: number;
    byStatus: Record<string, number>;
    /** Documents that needed review (policy or warnings). */
    reviewed: number;
    reviewRate: number | null;
    editsPerReviewed: number | null;
    /** Upload to finish, for succeeded documents. */
    avgProcessingSeconds: number | null;
  }[];
  steps: {
    stepId: string;
    runs: number;
    reruns: number;
    failures: number;
    avgAttempts: number;
    avgOutputTokens: number | null;
    avgSeconds: number | null;
  }[];
  /** Where reviewers correct most: field id or table.column. */
  topEdited: { target: string; edits: number }[];
}

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

export function computeMetrics(templateId: string, data: MetricsData): TemplateMetrics {
  const real = new Set(data.jobs.filter((j) => !j.test).map((j) => j.id));
  const editsByJob = groupBy(
    data.edits.filter((e) => real.has(e.jobId)),
    (e) => e.jobId,
  );

  const versions = [...groupBy(data.jobs, (j) => j.specVersion).entries()]
    .sort(([a], [b]) => a - b)
    .map(([version, jobs]) => {
      const docs = jobs.filter((j) => !j.test);
      const reviewed = docs.filter((j) => j.reviewReasons && j.reviewReasons.length > 0);
      const byStatus: Record<string, number> = {};
      for (const j of docs) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
      const editCount = reviewed.reduce((n, j) => n + (editsByJob.get(j.id)?.length ?? 0), 0);
      return {
        version,
        jobs: docs.length,
        testJobs: jobs.length - docs.length,
        byStatus,
        reviewed: reviewed.length,
        reviewRate: docs.length ? reviewed.length / docs.length : null,
        editsPerReviewed: reviewed.length ? editCount / reviewed.length : null,
        avgProcessingSeconds: mean(
          docs
            .filter((j) => j.status === 'succeeded')
            .map((j) => seconds(j.createdAt, j.updatedAt)),
        ),
      };
    });

  const steps = [...groupBy(data.stepRuns, (r) => r.stepId).entries()]
    .map(([stepId, runs]) => ({
      stepId,
      runs: runs.length,
      reruns: runs.filter((r) => r.trigger === 'rerun').length,
      failures: runs.filter((r) => r.status === 'failed').length,
      avgAttempts: mean(runs.map((r) => r.attempts)) ?? 0,
      avgOutputTokens: mean(runs.flatMap((r) => (r.outputTokens === null ? [] : [r.outputTokens]))),
      avgSeconds: mean(runs.map((r) => seconds(r.startedAt, r.finishedAt))),
    }))
    .sort((a, b) => a.stepId.localeCompare(b.stepId));

  const targets = groupBy(
    data.edits.filter((e) => real.has(e.jobId)),
    (e) => e.field ?? `${e.table}.${e.column}`,
  );
  const topEdited = [...targets.entries()]
    .map(([target, edits]) => ({ target, edits: edits.length }))
    .sort((a, b) => b.edits - a.edits || a.target.localeCompare(b.target))
    .slice(0, 10);

  return { templateId, versions, steps, topEdited };
}
