import type { FastifyInstance } from 'fastify';
import { runDiagnostics, type DiagnosticRun, type RunDiagnostics } from '@ih/shared';
import type { TemplateRecord } from '../templates/repo.js';

/** Approving a run makes its task `publish`, a step re-run `rerun`: both are still its run. */
const RUN_TASKS: readonly string[] = ['process', 'rerun', 'publish'];
/** The events runDiagnostics reads besides `segmented`: a step's extraction, re-run or cache hit. */
const STEP_EVENT_PREFIXES = ['extracted ', 're-ran ', 'reused cached '];

interface DraftIssue {
  step?: unknown;
  target?: unknown;
  column?: unknown;
  field?: unknown;
  raw?: unknown;
  message?: unknown;
}

/** Normalisation issues of a job's draft document.json (none when it is missing or unreadable). */
async function draftIssues(app: FastifyInstance, jobId: string): Promise<DiagnosticRun['issues']> {
  const job = await app.deps.repo.getJob(jobId);
  const draft = job?.outputs.find((o) => o.stage === 'draft' && o.outputId === 'document');
  if (!draft) return [];
  const body = await app.deps.store.get(draft.bucket, draft.key);
  if (!body) return [];
  let issues: unknown;
  try {
    issues = (JSON.parse(body.toString('utf8')) as { issues?: unknown }).issues;
  } catch {
    return [];
  }
  if (!Array.isArray(issues)) return [];
  const out: DiagnosticRun['issues'] = [];
  for (const i of issues as DraftIssue[]) {
    if (typeof i?.step !== 'string' || typeof i.target !== 'string') continue;
    // Shape and segmentation advisories are not the normaliser's trouble with a column.
    if (i.step === 'shacl' || i.step === 'segment') continue;
    if (typeof i.raw !== 'string' && typeof i.raw !== 'number' && typeof i.raw !== 'boolean')
      continue;
    const column =
      typeof i.column === 'string' ? i.column : typeof i.field === 'string' ? i.field : null;
    const message = typeof i.message === 'string' ? i.message : '';
    out.push({ step: i.step, target: i.target, column, raw: String(i.raw), message });
  }
  return out;
}

interface FoundRun {
  jobId: string;
  createdAt: string;
  finishedAt: string;
  startedAt: string | null;
}

/**
 * What the newest finished dev test run of each ready dev sample shows about the open draft
 * (Part C). Only runs of the draft's own version created since its last save count (older runs
 * describe a recipe that no longer exists), and holdout samples are never read.
 */
export async function draftDiagnostics(
  app: FastifyInstance,
  projectId: string,
  draft: TemplateRecord,
  dev: { sampleId: string; filename: string; sha256: string }[],
): Promise<RunDiagnostics | null> {
  if (!dev.length) return null;
  const since = Date.parse(draft.updatedAt);
  const bySha = new Map(dev.map((s) => [s.sha256, s.filename]));
  const newest = new Map<string, FoundRun>();
  for (const { job, sha256 } of await app.deps.repo.listProjectRuns(projectId)) {
    if (!bySha.has(sha256)) continue;
    if (!RUN_TASKS.includes(job.task) || !job.test || job.specVersion !== draft.version) continue;
    if (job.status !== 'awaiting_review' && job.status !== 'succeeded') continue;
    if (Date.parse(job.createdAt) < since) continue;
    const seen = newest.get(sha256);
    if (!seen || job.createdAt > seen.createdAt) {
      newest.set(sha256, {
        jobId: job.id,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt ?? job.updatedAt,
        startedAt: job.startedAt,
      });
    }
  }
  const read = async ([sha256, found]: [string, FoundRun]): Promise<DiagnosticRun | null> => {
    let parts;
    try {
      parts = await Promise.all([
        // A retry reuses the job row: only the latest attempt's events describe this run.
        app.deps.repo.listEvents(found.jobId, {
          ...(found.startedAt === null ? {} : { since: found.startedAt }),
          messages: { exact: ['segmented'], prefixes: STEP_EVENT_PREFIXES },
        }),
        app.deps.repo.listStepRuns(found.jobId),
        draftIssues(app, found.jobId),
      ]);
    } catch (err) {
      // Diagnostics are advisory: a run that cannot be read is left out, never blocking revise.
      app.log.warn({ err, jobId: found.jobId }, 'run diagnostics: could not read a run');
      return null;
    }
    const [events, stepRuns, issues] = parts;
    return {
      jobId: found.jobId,
      sample: bySha.get(sha256)!,
      events: events.map((e) => ({ message: e.message, data: e.data })),
      stepRuns: stepRuns.map((r) => ({
        stepId: r.stepId,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        cached: r.cached,
      })),
      issues,
    };
  };
  const results = await Promise.all([...newest].map(read));
  const runs = results.filter((r): r is DiagnosticRun => r !== null);
  let at = '';
  for (const found of newest.values())
    if (found.finishedAt > at && runs.some((r) => r.jobId === found.jobId)) at = found.finishedAt;
  if (!runs.length) return null;
  return runDiagnostics(runs, draft.version, at || new Date().toISOString());
}
