import type { FastifyPluginAsync } from 'fastify';
import {
  GRAPH_PUBLISHED_EVENT,
  JobDetailSchema,
  JobStatusSchema,
  StatusGroupSchema,
  JobPageQuerySchema,
  JobPageSchema,
  pageOfJobs,
  JobSummarySchema,
  modelRefProblem,
  pagePreviewKey,
  QueueSummarySchema,
  sourceContentType,
  type JobSummary,
  outputContentType,
  outputExtension,
  ShaclReportSchema,
  shaclReportKey,
} from '@ih/shared';
import { z } from 'zod';
import { binary, error, md, noContent, res } from '../openapi/zod.js';
import { removeJobFiles } from '../jobs/delete.js';
import { jobGraph, jobProgress, PROGRESS_EVENTS, stageTimes } from '../jobs/progress.js';
import { queueSummary } from '../jobs/queue-summary.js';
import {
  draftOutputsSnapshot,
  resolveDefinition,
  runnableModels,
} from '../templates/definitions.js';
import { retiredProblem, RETIRED_DOC } from '../templates/retirement.js';
import { OutputUnavailableError, readOutput } from '../storage/stage.js';
import { creatorOf } from '../access/routes.js';

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50).describe('At most 500.'),
  status: JobStatusSchema.optional().describe('Only jobs in this status.'),
  group: StatusGroupSchema.optional().describe(
    'Only jobs of this status group: `attention` (awaiting review, needs review, failed), ' +
      '`active` (queued, running, delivering) or `done` (succeeded, rejected, cancelled).',
  ),
  mine: z
    .enum(['0', '1'])
    .optional()
    .describe(
      '`1`: only jobs queued by the signed-in token (matched by its label); none without ' +
        'access control.',
    ),
});

const UUID = z.string().uuid();
const JobParams = z.object({ id: z.string().uuid().describe('The job id.') });
const NOT_FOUND = error('`not found`: no job with this id.');

/**
 * Content-Disposition for a user-supplied file name: an ASCII fallback that can't break out of
 * the quoted value (Node rejects non-Latin-1 header bytes outright), plus the exact name as
 * RFC 5987 `filename*` when it isn't plain ASCII.
 */
/** Percent-encode for RFC 5987 ext-value (encodeURIComponent leaves ' ( ) * as-is). */
const rfc5987 = (s: string) =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function contentDisposition(name: string, type: 'inline' | 'attachment' = 'inline'): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  // eslint-disable-next-line no-control-regex -- detecting non-ASCII is the point
  const exact = /[^\x00-\x7f]/.test(name) ? `; filename*=UTF-8''${rfc5987(name)}` : '';
  return `${type}; filename="${ascii}"${exact}`;
}

/** model: a ref sets the job's override, null clears it (spec default), absent keeps it. */
const RetryBody = z.object({
  model: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "A model choice's id (or an offered model ref) to use, null for the document type's models, absent to keep the job's.",
    ),
});

const CleanupBody = z.object({
  olderThanDays: z.number().int().min(1).max(3650),
  dryRun: z.boolean(),
  /** Regression runs feed scores and metrics: kept unless explicitly included. */
  includeRegression: z.boolean().default(false),
  /** The preview's cutoff, so the delete matches what was previewed (not "now - N days"). */
  cutoff: z.string().datetime().optional(),
  /** Jobs deleted per request; the client repeats while `remaining` > 0. */
  limit: z.number().int().min(1).max(500).default(100),
});

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/jobs',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'listJobs',
        summary: 'List jobs',
        description: md`
          The newest jobs first, optionally of one status or one status group (\`group\`: the
          app asks for every job needing attention this way, so none is missed behind the
          newest ones), and with \`mine=1\` only those queued
          by the signed-in user: by user id (\`createdByUser\`), so a rename keeps them; jobs
          from before ids were recorded match by name (\`createdBy\`). Lists the jobs of uploaded documents (production,
          test and regression runs); the Workbench's preparation, preview, drafting and export
          jobs are not listed.
        `,
        querystring: ListQuery,
        response: {
          200: res('The jobs.', z.array(JobSummarySchema)),
          400: error('Zod issues for an invalid `limit`, `status` or `group`.'),
        },
      },
    },
    async (req, reply) => {
      const query = ListQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: query.error.issues });
      const { mine, ...rest } = query.data;
      if (mine !== '1') return app.deps.repo.listJobs(rest);
      // Without access control nobody is signed in, so nothing is "mine".
      const me = creatorOf(req);
      if (!me) return [];
      return app.deps.repo.listJobs({ ...rest, mine: me });
    },
  );

  app.get(
    '/jobs/page',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'listJobPage',
        summary: 'One page of the Jobs list',
        description: md`
          The Jobs page's list, paged on the server: newest first (by \`createdAt\`, then
          \`id\`), \`size\` jobs from a job's place in the list rather than a page number, so
          jobs arriving at the top never shift the page being read. \`before\` gives the jobs
          just older than that job (Older ›), \`after\` the ones just newer (‹ Newer; a full
          page where there are enough), \`from\` that job and older (a linked job); none gives
          the newest. A job no longer listed (deleted) pages from the newest. \`group\`,
          \`mine=1\` and \`q\` (every word in the file name, document type id, status,
          model override or a model used) narrow the view. \`start\` counts the jobs of the
          view newer than the first one shown and \`total\` the view; \`counts\` are per
          status group with \`mine\` and \`q\` applied but not \`group\` (the chips).
          Lists the same jobs as \`GET /api/jobs\`.
        `,
        querystring: JobPageQuerySchema,
        response: {
          200: res('The page.', JobPageSchema),
          400: error(
            'Zod issues for an invalid query, or more than one of `before`, `after`, `from`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const query = JobPageQuerySchema.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: query.error.issues });
      const { mine, ...rest } = query.data;
      if (mine !== '1') return app.deps.repo.jobPage(rest);
      // Without access control nobody is signed in, so nothing is "mine".
      const me = creatorOf(req);
      if (!me) return pageOfJobs([], rest);
      return app.deps.repo.jobPage({ ...rest, mine: me });
    },
  );

  app.get(
    '/queue/summary',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'getQueueSummary',
        summary: 'How long a new run would wait',
        description: md`
          The queue a new Workbench test run waits behind: \`ahead\` counts the queued jobs
          with a document (production first, then earlier Workbench runs), \`running\` the jobs
          running now, and \`etaSeconds\` is a rough wait from the median duration of the
          newest timed runs of the last 24 hours, shared among the busy workers (null without
          such runs; 0 when nothing is queued). Counts only: no job or project is named.
        `,
        response: { 200: res('The queue.', QueueSummarySchema) },
      },
    },
    async () => queueSummary(await app.deps.repo.queueStats()),
  );

  app.get<{ Params: { id: string } }>(
    '/jobs/:id',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'getJob',
        summary: 'Get a job',
        description: md`
          A job with its outputs: the drafts written before review (\`stage: draft\`, outputs
          bucket) and the copies delivered to the final target (\`stage: published\`).
          Download one with \`GET /api/jobs/{id}/outputs/{outputId}\`. While an extraction
          runs, \`progress\` says where it is (as \`GET /api/jobs/{id}/events\` sends it);
          \`stageTimes\` says when this attempt finished reading the document and found its
          sections. \`graph\` is the newest graph the job published (ADR 0011): its IRI,
          version and triples, and whether it reached the triple store. \`deliveries\` are its
          deliveries through the delivery bridge, each target's latest status (a \`delivering\`
          job finishes when all are final).
        `,
        params: JobParams,
        response: { 200: res('The job.', JobDetailSchema), 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'not found' });
      }
      const job = await app.deps.repo.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: 'not found' });
      const events = await app.deps.repo.latestEvents(
        [job.id],
        [...PROGRESS_EVENTS, GRAPH_PUBLISHED_EVENT],
      );
      const deliveries = await app.deps.repo.deliveriesOf(job.id);
      const listed = deliveries.length ? await app.deps.targets.list() : [];
      const labels = new Map(listed.map((t) => [t.id, t.label]));
      const sinks = app.deps.sinks!;
      const sinkOf = new Map(listed.filter((t) => t.kind === 'sink').map((t) => [t.id, t.sinkId]));
      if (sinkOf.size) await sinks.refresh(app.deps.bridge);
      const deliverOnly = (targetId: string) => {
        const sinkId = sinkOf.get(targetId);
        return sinkId !== undefined && !sinks.get(sinkId)?.capabilities.withdraw;
      };
      return {
        ...job,
        progress: jobProgress(job, events),
        stageTimes: stageTimes(job, events),
        graph: jobGraph(events),
        deliveries: deliveries.map((d) => ({
          targetId: d.targetId,
          label: labels.get(d.targetId) ?? d.targetId,
          status: d.status,
          message: d.error?.message ?? null,
          deliverOnly: deliverOnly(d.targetId),
          links: (d.receipt?.written ?? []).flatMap((w) =>
            w.url && /^https?:\/\//i.test(w.url) ? [{ label: w.label ?? w.id, url: w.url }] : [],
          ),
        })),
      };
    },
  );

  /**
   * The version a retry re-processes with: the latest published (or newest file) version.
   * Test runs (a draft under test), regression runs (pinned to a version) and cancelled
   * publish/rerun tasks (review edits belong to the reviewed version) keep theirs.
   */
  async function latestVersionFor(job: JobSummary): Promise<number | undefined> {
    const reprocesses = job.status !== 'cancelled' || job.task === 'process';
    if (!reprocesses || job.test || job.referenceId) return undefined;
    const latest = await resolveDefinition(app.deps, job.specId);
    return latest?.ok ? latest.definition.version : undefined;
  }

  /**
   * A retried test run of a draft re-processes against the draft as it is now: refresh its
   * outputs snapshot (`params.outputs`), which Save as reference trusts.
   */
  async function draftSnapshotFor(job: JobSummary): Promise<{ outputs?: unknown }> {
    const reprocesses = job.status !== 'cancelled' || job.task === 'process';
    if (!reprocesses || !job.test || job.task === 'prepare') return {};
    const record = await app.deps.templates.get(job.specId, job.specVersion);
    return record?.status === 'draft' ? draftOutputsSnapshot(record.definition) : {};
  }

  app.post<{ Params: { id: string } }>(
    '/jobs/:id/retry',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'retryJob',
        summary: 'Retry a job',
        description: md`
          Queues a \`failed\`, \`needs_review\`, \`cancelled\` or \`succeeded\` job again with
          its attempts reset. It re-processes with the document type's latest published version,
          except test runs, regression runs and cancelled publish or re-run tasks, which keep
          their version. A cancelled publish or step re-run resumes as that task; any other job
          is processed from scratch. Retrying a \`succeeded\` job re-extracts it: its review and
          edits are cleared.
        `,
        params: JobParams,
        body: RetryBody,
        response: {
          200: res('The queued job.', JobSummarySchema),
          400: error(
            '`model must be a model ref or null`, or a model that is no choice or is not offered.',
          ),
          404: NOT_FOUND,
          409: error('`job not found or not in a retryable state`, or ' + RETIRED_DOC + '.'),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      const body = RetryBody.safeParse(req.body ?? {});
      if (!body.success)
        return reply.code(400).send({ error: 'model must be a model ref or null' });
      const { model } = body.data;
      if (model) {
        const { offered, aliases } = await runnableModels(app.deps);
        const problem = modelRefProblem(model, offered, aliases);
        if (problem) return reply.code(400).send({ error: problem });
      }
      const current = await app.deps.repo.getJob(req.params.id);
      // A retry is new work: a retired document type is refused (its old jobs stay readable).
      const retired = current ? await retiredProblem(app.deps, current.specId) : null;
      if (retired) return reply.code(409).send({ error: retired });
      const job = await app.deps.repo.retryJob(req.params.id, {
        model,
        specVersion: current ? await latestVersionFor(current) : undefined,
        ...(current ? await draftSnapshotFor(current) : {}),
      });
      return job ?? reply.code(409).send({ error: 'job not found or not in a retryable state' });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/jobs/:id/cancel',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'cancelJob',
        summary: 'Cancel a queued or running job',
        description: md`
          Marks a \`queued\` or \`running\` job \`cancelled\`. A running job stops at the
          worker's next safe point, and nothing it does afterwards changes the job's status.
          Retry resumes it. See
          [ADR 0005](https://github.com/kenhayward/ingestion-harness/blob/main/docs/adr/0005-job-cancellation-and-deletion.md).
        `,
        params: JobParams,
        response: {
          200: res('The cancelled job.', JobSummarySchema),
          404: NOT_FOUND,
          409: error('`only queued or running jobs can be cancelled`.'),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      if (!(await app.deps.repo.getJob(req.params.id))) {
        return reply.code(404).send({ error: 'not found' });
      }
      const job = await app.deps.repo.cancelJob(req.params.id);
      return job ?? reply.code(409).send({ error: 'only queued or running jobs can be cancelled' });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/jobs/:id',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'deleteJob',
        summary: 'Delete a finished job',
        description: md`
          Deletes a \`succeeded\`, \`failed\`, \`needs_review\`, \`rejected\` or \`cancelled\`
          job with its history, its draft outputs and its files in the runs bucket, and the
          uploaded PDF when no other job or Workbench sample uses it. What it delivered is
          withdrawn (ADR 0011): a queued \`withdraw\` job removes its published copies from the
          final target and, when it published the current version, its graph from the triple
          store. Queued and running jobs must be cancelled first, and jobs awaiting review
          decided.
        `,
        params: JobParams,
        response: {
          204: noContent('Deleted.'),
          404: NOT_FOUND,
          409: error('`a {status} job cannot be deleted: cancel or review it first`.'),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      const res = await app.deps.repo.deleteJob(req.params.id);
      if (res.result === 'not_found') return reply.code(404).send({ error: 'not found' });
      if (res.result === 'conflict') {
        return reply
          .code(409)
          .send({ error: `a ${res.status} job cannot be deleted: cancel or review it first` });
      }
      await removeJobFiles(app.deps, res.removed, req.log);
      return reply.code(204).send();
    },
  );

  /** Bulk delete of finished jobs older than N days (dryRun: count only). */
  app.post(
    '/jobs/cleanup',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'cleanupJobs',
        summary: 'Delete finished jobs older than N days',
        description: md`
          Bulk version of \`DELETE /api/jobs/{id}\` for finished jobs last updated before a
          cutoff (now minus \`olderThanDays\`). Regression runs are kept unless
          \`includeRegression\` is true, since scores and metrics are computed from them.
          Like a single delete, it **withdraws what the jobs delivered**: their published
          outputs leave the final target (the data lake) and their graphs the triple store.

          Run it with \`dryRun: true\` first: the response counts the jobs and returns the
          \`cutoff\`. Then delete with \`dryRun: false\`, passing that \`cutoff\` so the
          delete matches what was previewed. Each request deletes at most \`limit\` jobs and
          reports how many are \`remaining\`; repeat while it is above 0. A job whose status
          changed in between is skipped.
        `,
        body: CleanupBody,
        response: {
          200: res(
            'The dry-run count, or what was deleted.',
            z.union([
              z.object({ count: z.number().int(), cutoff: z.string() }),
              z.object({
                deleted: z.number().int(),
                remaining: z.number().int(),
                cutoff: z.string(),
              }),
            ]),
          ),
          400: error('The invalid fields, e.g. `olderThanDays: Number must be at least 1`.'),
        },
      },
    },
    async (req, reply) => {
      const body = CleanupBody.safeParse(req.body);
      if (!body.success) {
        const error = body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return reply.code(400).send({ error });
      }
      const { olderThanDays, dryRun, includeRegression, limit } = body.data;
      const cutoff =
        body.data.cutoff ?? new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
      const ids = await app.deps.repo.finishedJobIdsBefore(cutoff, includeRegression);
      if (dryRun) return { count: ids.length, cutoff };
      let deleted = 0;
      for (const id of ids.slice(0, limit)) {
        const res = await app.deps.repo.deleteJob(id);
        if (res.result !== 'deleted') continue; // status changed meanwhile: skip it
        deleted++;
        await removeJobFiles(app.deps, res.removed, req.log);
      }
      return { deleted, remaining: Math.max(0, ids.length - limit), cutoff };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/jobs/:id/shacl-report',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'getShaclReport',
        summary: "Get a job's SHACL report",
        description: md`
          The SHACL report of the job's document graph (ADR 0011): written when its recipe pins
          shapes and a graph was rendered, at processing and again at publishing. Violations
          are review reasons and refuse a publish that delivers RDF; warnings and infos are
          issues. Each result names the output (\`field\`, \`table.column\`) its path publishes.
        `,
        params: z.object({ id: z.string().uuid().describe('The job id.') }),
        response: {
          200: res('The report.', ShaclReportSchema),
          404: error('`no SHACL report for this job`, or `not found`.'),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      if (!(await app.deps.repo.getJob(req.params.id))) {
        return reply.code(404).send({ error: 'not found' });
      }
      const raw = await app.deps.store.get(app.deps.buckets.runs, shaclReportKey(req.params.id));
      const report = raw ? ShaclReportSchema.safeParse(JSON.parse(raw.toString('utf8'))) : null;
      if (!report?.success) return reply.code(404).send({ error: 'no SHACL report for this job' });
      return report.data;
    },
  );

  app.get<{
    Params: { id: string; outputId: string };
    Querystring: { stage?: string; inline?: string };
  }>(
    '/jobs/:id/outputs/:outputId',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'downloadJobOutput',
        summary: 'Download a job output',
        description: md`
          One output file of a job, as CSV or JSON. A reviewed job has two copies of each
          output: the draft and the published one. The published copy is served unless
          \`stage=draft\` asks for the draft. Published copies are read from the publishing
          target recorded with them.
          \`inline=1\` asks the browser to show the file instead of downloading it.
        `,
        params: z.object({
          id: z.string().uuid().describe('The job id.'),
          outputId: z.string().describe('The output id, e.g. `document` or a table id.'),
        }),
        querystring: z.object({
          stage: z.enum(['draft', 'published']).optional(),
          inline: z.enum(['1']).optional(),
        }),
        response: {
          200: binary('The output file.', 'text/csv', 'application/json', 'text/turtle'),
          400: error('`stage must be draft or published`.'),
          404: error(
            '`not found`, `output not found`, or the object is missing from storage or the target.',
          ),
          502: error(
            '`storage unavailable` (a draft), or `publishing target {label} unavailable`: the ' +
              'target is missing, its credentials cannot be used, or it does not answer.',
          ),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      const { stage, inline } = req.query;
      if (stage !== undefined && stage !== 'draft' && stage !== 'published') {
        return reply.code(400).send({ error: 'stage must be draft or published' });
      }
      const job = await app.deps.repo.getJob(req.params.id);
      const matches = (job?.outputs ?? []).filter(
        (o) => o.outputId === req.params.outputId && (stage === undefined || o.stage === stage),
      );
      // A reviewed job has a draft and a published copy: default to what was delivered.
      const output = matches.find((o) => o.stage === 'published') ?? matches[0];
      if (!output) return reply.code(404).send({ error: 'output not found' });

      const where = output.stage === 'published' ? 'target' : 'storage';
      let body: Buffer | null;
      try {
        body = await readOutput(app.deps, output);
      } catch (err) {
        if (!(err instanceof OutputUnavailableError)) throw err;
        req.log.warn({ err: err.cause, bucket: output.bucket }, 'output read failed');
        return reply.code(502).send({ error: err.message });
      }
      if (!body) return reply.code(404).send({ error: `output object missing from ${where}` });
      const filename =
        output.key.split('/').pop() ?? `${output.outputId}.${outputExtension(output.format)}`;
      return (
        reply
          .header('content-type', outputContentType(output.format))
          .header(
            'content-disposition',
            `${inline === '1' ? 'inline' : 'attachment'}; filename="${filename}"`,
          )
          // Output bodies are LLM-derived: never let a browser sniff them into another type.
          .header('x-content-type-options', 'nosniff')
          .send(body)
      );
    },
  );

  /**
   * The uploaded file from the inbox bucket: a PDF inline (Jobs "Open PDF"), a Word document
   * as a download (browsers cannot show it).
   */
  app.get<{ Params: { id: string } }>(
    '/jobs/:id/document',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'getJobDocument',
        summary: 'Download the uploaded document',
        description: md`
          The file the job processes, from the inbox bucket, under its original file name. A
          PDF is served inline; a Word document (\`.docx\`) as an attachment with its own
          content type. The job's \`contentType\` says which it is.
        `,
        params: JobParams,
        response: {
          200: binary('The uploaded file: a PDF or a Word document.', 'application/pdf'),
          404: error('`not found`, or `document missing from storage`.'),
          502: error('`storage unavailable`.'),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      const doc = await app.deps.repo.getDocumentObject(req.params.id);
      if (!doc) return reply.code(404).send({ error: 'not found' });
      let body: Buffer | null;
      try {
        body = await app.deps.store.get(doc.bucket, doc.key);
      } catch (err) {
        req.log.warn({ err, bucket: doc.bucket }, 'document read failed');
        return reply.code(502).send({ error: 'storage unavailable' });
      }
      if (!body) return reply.code(404).send({ error: 'document missing from storage' });
      const type = sourceContentType(doc.key);
      return reply
        .header('content-type', type)
        .header(
          'content-disposition',
          contentDisposition(doc.filename, type === 'application/pdf' ? 'inline' : 'attachment'),
        )
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, max-age=300')
        .send(body);
    },
  );

  /** JPEG page preview rendered by the worker (review screen). */
  app.get<{ Params: { id: string; n: string } }>(
    '/jobs/:id/pages/:n',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'getJobPage',
        summary: 'Get a page preview image',
        description: md`
          A JPEG of one page of the job's document, rendered by the worker for the review
          screen. Pages are numbered from 1.
        `,
        params: z.object({
          id: z.string().uuid().describe('The job id.'),
          n: z.string().describe('The 1-based page number.'),
        }),
        response: {
          200: binary('The page image.', 'image/jpeg'),
          400: error('`page must be a positive integer`.'),
          404: error('`not found`, or `page preview not found`.'),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      const page = Number(req.params.n);
      if (!Number.isInteger(page) || page < 1 || page > 5000) {
        return reply.code(400).send({ error: 'page must be a positive integer' });
      }
      const body = await app.deps.store.get(
        app.deps.buckets.runs,
        pagePreviewKey(req.params.id, page),
      );
      if (!body) return reply.code(404).send({ error: 'page preview not found' });
      return reply
        .header('content-type', 'image/jpeg')
        .header('cache-control', 'private, max-age=3600')
        .send(body);
    },
  );
};
