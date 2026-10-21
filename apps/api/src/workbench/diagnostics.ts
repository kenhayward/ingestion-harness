import type { FastifyInstance } from 'fastify';
import { runDiagnostics, type DiagnosticRun, type RunDiagnostics } from '@ih/shared';
import type { TemplateRecord } from '../templates/repo.js';

interface DraftIssue {
  step?: unknown;
  target?: unknown;
  column?: unknown;
  field?: unknown;
  raw?: unknown;
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
    if (typeof i?.step !== 'string' || typeof i.target !== 'string' || typeof i.raw !== 'string')
      continue;
    const column =
      typeof i.column === 'string' ? i.column : typeof i.field === 'string' ? i.field : null;
    out.push({ step: i.step, target: i.target, column, raw: i.raw });
  }
  return out;
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
  const newest = new Map<string, { jobId: string; createdAt: string; finishedAt: string }>();
  for (const { job, sha256 } of await app.deps.repo.listProjectRuns(projectId)) {
    if (!bySha.has(sha256)) continue;
    if (job.task !== 'process' || !job.test || job.specVersion !== draft.version) continue;
    if (job.status !== 'awaiting_review' && job.status !== 'succeeded') continue;
    if (Date.parse(job.createdAt) < since) continue;
    const seen = newest.get(sha256);
    if (!seen || job.createdAt > seen.createdAt) {
      newest.set(sha256, { jobId: job.id, createdAt: job.createdAt, finishedAt: job.updatedAt });
    }
  }
  const runs: DiagnosticRun[] = [];
  let at = '';
  for (const [sha256, found] of newest) {
    const [events, stepRuns, issues] = await Promise.all([
      app.deps.repo.listEvents(found.jobId),
      app.deps.repo.listStepRuns(found.jobId),
      draftIssues(app, found.jobId),
    ]);
    if (found.finishedAt > at) at = found.finishedAt;
    runs.push({
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
    });
  }
  if (!runs.length) return null;
  return runDiagnostics(runs, draft.version, at || new Date().toISOString());
}
