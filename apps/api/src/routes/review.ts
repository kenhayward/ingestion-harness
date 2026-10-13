import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  ApproveRequestSchema,
  EditRequestSchema,
  JobDetailSchema,
  JobSummarySchema,
  modelRefProblem,
  RejectRequestSchema,
  RerunRequestSchema,
  ReviewEditSchema,
  StepRunSchema,
  TemplateSchema,
  type JobDetail,
  type Template,
} from '@ih/shared';
import { z } from 'zod';
import { error, md, res } from '../openapi/zod.js';
import { resolveDefinition, runnableModels } from '../templates/definitions.js';

const UUID = z.string().uuid();
const JobParams = z.object({ id: z.string().uuid().describe('The job id.') });

/** The draft document.json, as the review screen reads it. */
const DraftDocumentSchema = z
  .object({
    fields: z.record(
      z.object({
        value: z.unknown(),
        evidence: z.string().nullable().describe('The text the value was read from.'),
        page: z.number().int().nullable(),
      }),
    ),
    tables: z.record(z.array(z.record(z.unknown()))),
  })
  .passthrough();

const ReviewViewSchema = z.object({
  job: JobDetailSchema,
  template: TemplateSchema.describe('The recipe version the job ran with.'),
  document: DraftDocumentSchema,
  edits: z.array(ReviewEditSchema).describe('Edits so far, oldest first.'),
});

const NO_REVIEW = error(
  '`not found`, `job did not run a recipe`, `no draft document for this job` or ' +
    '`draft document missing from storage`.',
);
const DECIDED = error('`job not found or not awaiting review`.');
const NOT_AWAITING = error('`job is {status}, not awaiting_review`.');
/** Draft document.json written by the worker (template jobs). */
interface DraftDocument {
  fields: Record<string, { value: unknown; evidence: string | null; page: number | null }>;
  tables: Record<string, Record<string, unknown>[]>;
  [key: string]: unknown;
}

interface ReviewContext {
  job: JobDetail;
  template: Template;
  document: DraftDocument;
}

async function loadContext(
  app: FastifyInstance,
  jobId: string,
  reply: FastifyReply,
): Promise<ReviewContext | null> {
  const notFound = (error: string) => {
    void reply.code(404).send({ error });
    return null;
  };
  if (!UUID.safeParse(jobId).success) return notFound('not found');
  const job = await app.deps.repo.getJob(jobId);
  if (!job) return notFound('not found');
  const resolved = await resolveDefinition(app.deps, job.specId, job.specVersion);
  const def = resolved?.ok ? resolved.definition : undefined;
  if (def?.kind !== 'template') return notFound('job did not run a recipe');
  const draft = job.outputs.find((o) => o.stage === 'draft' && o.outputId === 'document');
  if (!draft) return notFound('no draft document for this job');
  const body = await app.deps.store.get(draft.bucket, draft.key);
  if (!body) return notFound('draft document missing from storage');
  return { job, template: def.template, document: JSON.parse(body.toString('utf8')) };
}

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  /** Everything a reviewer needs: job, template definitions, draft document, edits so far. */
  app.get<{ Params: { id: string } }>(
    '/jobs/:id/review',
    {
      schema: {
        tags: ['Review & steps'],
        operationId: 'getReview',
        summary: 'Get a job for review',
        description: md`
          Everything the review screen needs for a recipe job: the job, the recipe version
          it ran with, the draft document (each field's value with the text and page it came
          from, and the table rows) and the edits recorded so far. Available whenever the job
          has a draft document, not only while it awaits review.
        `,
        params: JobParams,
        response: { 200: res('The review view.', ReviewViewSchema), 404: NO_REVIEW },
      },
    },
    async (req, reply) => {
      const ctx = await loadContext(app, req.params.id, reply);
      if (!ctx) return reply;
      const edits = await app.deps.repo.listEdits(ctx.job.id);
      return { job: ctx.job, template: ctx.template, document: ctx.document, edits };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/jobs/:id/edits',
    {
      schema: {
        tags: ['Review & steps'],
        operationId: 'addEdit',
        summary: 'Record a reviewer edit',
        description: md`
          Corrects one value of a job awaiting review: a field (\`field\`) or a table cell
          (\`table\`, 1-based \`row\`, \`column\`). Edits are appended, never overwritten:
          \`oldValue\` is the previous edit's value for the same target, or the draft's. A row
          one past the end adds a row. Approving applies the edits to the published document.
        `,
        params: JobParams,
        body: EditRequestSchema,
        response: {
          201: res('The recorded edit.', ReviewEditSchema),
          400: error(
            '`invalid edit` (with `issues`), an unknown field, table or column, or a row that ' +
              'does not exist.',
          ),
          404: NO_REVIEW,
          409: NOT_AWAITING,
        },
      },
    },
    async (req, reply) => {
      const ctx = await loadContext(app, req.params.id, reply);
      if (!ctx) return reply;
      if (ctx.job.status !== 'awaiting_review') {
        return reply.code(409).send({ error: `job is ${ctx.job.status}, not awaiting_review` });
      }
      const parsed = EditRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid edit', issues: parsed.error.issues });
      }
      const edit = parsed.data;
      const { template, document } = ctx;
      const previous = await app.deps.repo.listEdits(ctx.job.id);

      let draftValue: unknown;
      let sameTarget: (e: (typeof previous)[number]) => boolean;
      if ('field' in edit) {
        if (!template.outputs.fields.some((f) => f.id === edit.field)) {
          return reply.code(400).send({ error: `unknown field "${edit.field}"` });
        }
        draftValue = document.fields[edit.field]?.value ?? null;
        sameTarget = (e) => e.field === edit.field;
      } else {
        const table = template.outputs.tables.find((t) => t.id === edit.table);
        if (!table) return reply.code(400).send({ error: `unknown table "${edit.table}"` });
        if (!table.columns.some((c) => c.id === edit.column)) {
          return reply.code(400).send({ error: `unknown column "${edit.table}.${edit.column}"` });
        }
        const rows = document.tables[edit.table] ?? [];
        if (edit.row > rows.length) {
          return reply.code(400).send({
            error: `row ${edit.row} of "${edit.table}" does not exist (${rows.length} rows)`,
          });
        }
        draftValue = rows[edit.row - 1]?.[edit.column] ?? null;
        sameTarget = (e) =>
          e.table === edit.table && e.row === edit.row && e.column === edit.column;
      }
      const last = previous.filter(sameTarget).at(-1);

      const saved = await app.deps.repo.addEdit(ctx.job.id, {
        field: 'field' in edit ? edit.field : null,
        table: 'table' in edit ? edit.table : null,
        row: 'table' in edit ? edit.row : null,
        column: 'table' in edit ? edit.column : null,
        oldValue: last ? last.newValue : draftValue,
        newValue: edit.value ?? null,
        editor: edit.editor ?? null,
        reason: edit.reason ?? null,
      });
      return reply.code(201).send(saved);
    },
  );

  /**
   * Approve: queue the publish task. A test run's approval (e.g. a workbench reference run)
   * writes the reviewed document but is never delivered to the target (worker publish_job).
   */
  app.post<{ Params: { id: string } }>(
    '/jobs/:id/approve',
    {
      schema: {
        tags: ['Review & steps'],
        operationId: 'approveJob',
        summary: 'Approve a job awaiting review',
        description: md`
          Approves the reviewed values: the job is queued again as a \`publish\` task, which
          applies the edits and delivers the outputs to the final target. A test run (such as a
          Workbench reference run) is never delivered: its reviewed document is written to the
          runs bucket and the job succeeds. See
          [the job lifecycle](https://github.com/kenhayward/ingestion-harness/blob/main/docs/architecture.md#job-lifecycle).
        `,
        params: JobParams,
        body: ApproveRequestSchema,
        response: {
          200: res('The job, queued to publish.', JobSummarySchema),
          400: error('Zod issues for an invalid body.'),
          404: error('`not found`: a malformed job id.'),
          409: DECIDED,
        },
      },
    },
    async (req, reply) => {
      const body = ApproveRequestSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      const job = await app.deps.repo.approve(
        req.params.id,
        body.data.reviewer ?? null,
        body.data.note ?? null,
      );
      return job ?? reply.code(409).send({ error: 'job not found or not awaiting review' });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/jobs/:id/reject',
    {
      schema: {
        tags: ['Review & steps'],
        operationId: 'rejectJob',
        summary: 'Reject a job awaiting review',
        description: md`
          Rejects the extracted values with a reason. Rejection is final: nothing is delivered,
          and the job cannot be retried.
        `,
        params: JobParams,
        body: RejectRequestSchema,
        response: {
          200: res('The rejected job.', JobSummarySchema),
          400: error('Zod issues: `reason` is required.'),
          404: error('`not found`: a malformed job id.'),
          409: DECIDED,
        },
      },
    },
    async (req, reply) => {
      const body = RejectRequestSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      const job = await app.deps.repo.reject(
        req.params.id,
        body.data.reviewer ?? null,
        body.data.reason,
      );
      return job ?? reply.code(409).send({ error: 'job not found or not awaiting review' });
    },
  );

  /** Recorded executions of each extract step (model, attempts, tokens, timing). */
  app.get<{ Params: { id: string } }>(
    '/jobs/:id/steps',
    {
      schema: {
        tags: ['Review & steps'],
        operationId: 'listStepRuns',
        summary: "List a job's step runs",
        description: md`
          Every recorded execution of the job's extract steps: the model used, attempts, token
          counts, timing and errors, including re-runs. \`cached\` marks a Workbench test run
          step served from the step cache (no model call). An unknown job has no runs.
        `,
        params: JobParams,
        response: {
          200: res('The step runs.', z.array(StepRunSchema)),
          404: error('`not found`: a malformed job id.'),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'not found' });
      }
      return app.deps.repo.listStepRuns(req.params.id);
    },
  );

  /** Re-run one extract step of a document in review (worker reuses OCR; checks re-run). */
  app.post<{ Params: { id: string; step: string } }>(
    '/jobs/:id/steps/:step/rerun',
    {
      schema: {
        tags: ['Review & steps'],
        operationId: 'rerunStep',
        summary: 'Re-run one extract step',
        description: md`
          Queues one extract step of a job awaiting review again, optionally with another
          model, extra instructions, or pages sent as images so a vision model reads them
          directly (e.g. handwriting). The worker reuses the document's text and OCR and re-runs
          the checks; the job returns to \`awaiting_review\` with the step's new values.

          Refused while the step's outputs have reviewer edits, since a re-run would discard
          them. \`model\` must be offered (\`GET /api/models\`) or an alias resolving to one.
        `,
        params: z.object({
          id: z.string().uuid().describe('The job id.'),
          step: z.string().describe('The extract step id.'),
        }),
        body: RerunRequestSchema,
        response: {
          200: res('The job, queued to re-run the step.', JobSummarySchema),
          400: error(
            'Zod issues for an invalid body, `no extract step "{step}"`, or a `model` that may ' +
              'not run: `model {ref} is not offered: add it on the Models page`, `alias {name} ' +
              'uses {ref}, which is not offered: …` or `unknown model alias {name}` (ADR 0010).',
          ),
          404: error('`not found`, or `job did not run a recipe`.'),
          409: error(
            '`job is {status}, not awaiting_review`, the step has reviewer edits, or the job ' +
              'is no longer awaiting review.',
          ),
        },
      },
    },
    async (req, reply) => {
      const body = RerunRequestSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (!UUID.safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'not found' });
      }
      const job = await app.deps.repo.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: 'not found' });
      if (job.status !== 'awaiting_review') {
        return reply.code(409).send({ error: `job is ${job.status}, not awaiting_review` });
      }
      const resolved = await resolveDefinition(app.deps, job.specId, job.specVersion);
      const def = resolved?.ok ? resolved.definition : undefined;
      if (def?.kind !== 'template') {
        return reply.code(404).send({ error: 'job did not run a recipe' });
      }
      const step = def.template.pipeline.find(
        (s) => s.type === 'extract' && s.id === req.params.step,
      );
      if (!step || step.type !== 'extract') {
        return reply.code(400).send({ error: `no extract step "${req.params.step}"` });
      }
      const edited = (await app.deps.repo.listEdits(job.id)).filter((e) =>
        e.field ? step.fields.includes(e.field) : e.table === step.table,
      );
      if (edited.length) {
        return reply.code(409).send({
          error: `step "${step.id}" outputs already have ${edited.length} reviewer edits; a re-run would discard them`,
        });
      }
      if (body.data.model) {
        // Only models offered on their endpoint run (ADR 0010); the worker refuses the rest too.
        const { offered, aliases } = await runnableModels(app.deps);
        const problem = modelRefProblem(body.data.model, offered, aliases);
        if (problem) return reply.code(400).send({ error: problem });
      }
      const updated = await app.deps.repo.requestRerun(job.id, step.id, body.data);
      return updated ?? reply.code(409).send({ error: 'job is no longer awaiting review' });
    },
  );
};
