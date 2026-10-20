import type { FastifyInstance } from 'fastify';
import {
  MAX_RETRIED_RUNS,
  RetriedRunsSchema,
  StepAttemptsSchema,
  type RetriedRun,
  type StepAttempt,
  type StepCall,
} from '@ih/shared';
import { z } from 'zod';
import { error, md, res } from '../openapi/zod.js';

const UUID = z.string().uuid();

/** `{job}/{step}/attempt-{n}.json` or `{job}/{step}.<part>/attempt-{n}.json` (`pipeline._audit`). */
function attemptKeyParts(jobId: string, stepId: string, key: string) {
  const prefix = `${jobId}/`;
  if (!key.startsWith(prefix)) return null;
  const m = /^([^/]+)\/attempt-(\d+)\.json$/.exec(key.slice(prefix.length));
  if (!m) return null;
  const label = m[1]!;
  if (label !== stepId && !label.startsWith(`${stepId}.`)) return null;
  return { label, n: Number(m[2]) };
}

/** `step` first, then its parts in natural order (`chunk-2` before `chunk-10`). */
const byLabel = (stepId: string) => (a: string, b: string) =>
  a === stepId ? -1 : b === stepId ? 1 : a.localeCompare(b, 'en', { numeric: true });

/** What the worker wrote (`extract.Attempt` as a dict), or null for anything else. */
function attemptOf(n: number, raw: unknown): StepAttempt | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
  return {
    n,
    prompt: typeof a.prompt === 'string' ? a.prompt : '',
    response: typeof a.response === 'string' ? a.response : '',
    errors: Array.isArray(a.errors) ? a.errors.map(String) : [],
    inputTokens: int(a.input_tokens),
    outputTokens: int(a.output_tokens),
  };
}

/** A recipe step's model log: its retried runs, and one run's saved attempts. */
export async function stepAttemptRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string; step: string } }>(
    '/templates/:id/steps/:step/retried-runs',
    {
      schema: {
        tags: ['Review & steps'],
        operationId: 'listRetriedStepRuns',
        summary: "List a step's runs that needed a retry",
        description: md`
          The newest runs (at most ${MAX_RETRIED_RUNS}) of one step of a document type that took
          more than one attempt: the model's first answer failed the step's checks and was sent
          back. One per job (its newest run of the step); steps served from the Workbench step
          cache are left out. Each one's attempts are at \`GET /api/jobs/{id}/steps/{step}/attempts\`.
        `,
        params: z.object({
          id: z.string().describe('The document type (recipe) id.'),
          step: z.string().describe('The step id.'),
        }),
        response: { 200: res('The retried runs, newest first.', RetriedRunsSchema) },
      },
    },
    async (req) => {
      const { id, step } = req.params;
      const data = await app.deps.repo.metricsData(id);
      const jobs = new Map(data.jobs.map((j) => [j.id, j]));
      const newest = new Map<string, (typeof data.stepRuns)[number]>();
      for (const r of data.stepRuns) {
        if (r.stepId !== step || r.cached || r.attempts < 2 || !jobs.has(r.jobId)) continue;
        const seen = newest.get(r.jobId);
        if (!seen || seen.startedAt < r.startedAt) newest.set(r.jobId, r);
      }
      const runs: RetriedRun[] = [...newest.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, MAX_RETRIED_RUNS)
        .map((r) => {
          const job = jobs.get(r.jobId)!;
          return {
            jobId: r.jobId,
            fileName: job.filename,
            version: job.specVersion,
            startedAt: r.startedAt,
            attempts: r.attempts,
            model: r.model,
            status: r.status,
            trigger: r.trigger,
          };
        });
      return { runs };
    },
  );

  app.get<{ Params: { id: string; step: string } }>(
    '/jobs/:id/steps/:step/attempts',
    {
      schema: {
        tags: ['Review & steps'],
        operationId: 'getStepAttempts',
        summary: "Get a step's saved attempts in one job",
        description: md`
          Every attempt the worker saved for one step of a job: the prompt it sent, the model's
          raw reply, and the errors that sent the reply back (empty for the accepted one), with
          token counts. A step makes one model call, or one per chunk of pages, occurrence of a
          repeating section or question a plugin asks; each is a \`call\` (\`step\` first, then
          \`step.chunk-1\`, \`step.occ-2\`, \`step.ask-1\`…). A re-run of the step replaces the
          attempts of the calls it makes again.
        `,
        params: z.object({
          id: z.string().describe('The job id.'),
          step: z.string().describe('The step id.'),
        }),
        response: {
          200: res('The calls and their attempts.', StepAttemptsSchema),
          404: error(
            '`not found` (a malformed job id), or `no saved attempts for step {step} of this job`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const { id, step } = req.params;
      if (!UUID.safeParse(id).success) return reply.code(404).send({ error: 'not found' });
      const bucket = app.deps.buckets.runs;
      const byCall = new Map<string, StepAttempt[]>();
      for await (const obj of app.deps.store.list(bucket, `${id}/${step}`)) {
        const parts = attemptKeyParts(id, step, obj.key);
        if (!parts) continue;
        const raw = await app.deps.store.get(bucket, obj.key);
        let parsed: unknown = null;
        try {
          parsed = raw ? (JSON.parse(raw.toString('utf8')) as unknown) : null;
        } catch {
          continue; // a corrupt audit file: leave it out
        }
        const a = attemptOf(parts.n, parsed);
        if (a) byCall.set(parts.label, [...(byCall.get(parts.label) ?? []), a]);
      }
      if (byCall.size === 0) {
        return reply.code(404).send({ error: `no saved attempts for step ${step} of this job` });
      }
      const calls: StepCall[] = [...byCall.keys()].sort(byLabel(step)).map((label) => ({
        label,
        attempts: byCall.get(label)!.sort((a, b) => a.n - b.n),
      }));
      return { calls };
    },
  );
}
