import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ComparisonSchema,
  JobStatusSchema,
  JobSummarySchema,
  ReferenceSchema,
  type JobDetail,
} from '@ih/shared';
import { error, md, noContent, res } from '../openapi/zod.js';
import { refuseRetired, RETIRED_DOC } from '../templates/retirement.js';
import { expectedFromDocument } from '../regression/compare.js';
import { jobDocument, regressionReport, versionReferences } from '../regression/report.js';
import { ChangeSchema, diffDefinitions } from '../regression/diff.js';
import { computeMetrics, TemplateMetricsSchema } from '../metrics.js';
import { ReferenceConflictError } from '../repositories/types.js';
import { draftOutputsSnapshot } from '../templates/definitions.js';
import { creatorOf } from '../access/routes.js';

const STALE = Symbol('stale');

const ListQuery = z
  .object({
    version: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe('A version: the references it is regression-tested against.'),
  })
  .strict();

const CreateReference = z
  .object({
    jobId: z.string().uuid().describe('A succeeded job of this document type.'),
    name: z.string().min(1).max(100),
  })
  .strict();

const TypeParams = z.object({ id: z.string().describe('The document type id.') });
const VersionParams = z.object({
  id: z.string().describe('The document type id.'),
  version: z.string().describe('The version number.'),
});

const RegressionReportSchema = z.object({
  items: z.array(
    z.object({
      reference: z.object({ id: z.string().uuid(), name: z.string() }),
      job: z
        .object({ id: z.string().uuid(), status: JobStatusSchema, error: z.string().nullable() })
        .nullable()
        .describe("The reference's latest regression job for this version; null if never run."),
      comparison: ComparisonSchema.nullable().describe(
        'Expected against actual values, once the job finished (or stopped for review).',
      ),
    }),
  ),
  summary: z.object({
    references: z.number().int(),
    completed: z.number().int(),
    averageScore: z.number().nullable(),
  }),
});

export const referenceRoutes: FastifyPluginAsync = async (app) => {
  const typeExists = async (id: string) =>
    (await app.deps.templates.list()).some((r) => r.id === id);

  /**
   * The outputs a Workbench run was checked against: its snapshot (`params.outputs`, written on
   * every test run of a draft), else its published version's outputs, else the draft's when the
   * draft has not changed since the run (STALE otherwise). A missing version gives `{}`, which a
   * reference never trusts once the version has outputs again.
   */
  const runOutputs = async (job: JobDetail): Promise<unknown> => {
    const params = await app.deps.repo.getJobParams(job.id);
    if (params && 'outputs' in params) return params.outputs ?? null;
    const record = await app.deps.templates.get(job.specId, job.specVersion);
    if (!record) return {};
    if (record.status === 'draft' && record.updatedAt > job.createdAt) return STALE;
    return (record.definition as { outputs?: unknown }).outputs ?? null;
  };

  app.get<{ Params: { id: string } }>(
    '/templates/:id/references',
    {
      schema: {
        tags: ['References & regression'],
        operationId: 'listReferences',
        summary: "List a document type's references",
        description: md`
          A reference is a document's verified values, kept as the expected result. Without
          \`version\`: every live reference of the document type. With \`version\`: the set
          that version is regression-tested against, one per PDF. A reference pinned to the
          version is preferred over an unpinned one; a reference verified against outputs the
          version has since changed is left out until it is verified again.
        `,
        params: TypeParams,
        querystring: ListQuery,
        response: {
          200: res('The references.', z.array(ReferenceSchema)),
          400: error('Zod issues for an invalid `version`.'),
        },
      },
    },
    async (req, reply) => {
      const query = ListQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: query.error.issues });
      const { version } = query.data;
      // With a version: the set regression runs against (outdated references left out).
      return version === undefined
        ? app.deps.repo.listReferences(req.params.id)
        : versionReferences(app, req.params.id, version);
    },
  );

  /** Save a finished job's (reviewed) values as the expected result for this document type. */
  app.post<{ Params: { id: string } }>(
    '/templates/:id/references',
    {
      schema: {
        tags: ['References & regression'],
        operationId: 'createReference',
        summary: "Save a job's values as a reference",
        description: md`
          Saves a succeeded job's values as the expected result for its document type: the
          reviewed document when it was reviewed, else the draft.

          For Workbench document types the reference is pinned to the job's version, together
          with the outputs the run was checked against: the run's snapshot, else the published
          version's outputs, else the draft's when it has not changed since the run (a 409
          otherwise: run it again). Earlier versions' references are carried forward first.
        `,
        params: TypeParams,
        body: CreateReference,
        response: {
          201: res('The new reference.', ReferenceSchema),
          400: error(
            'Zod issues for an invalid body, `job is not a {id} document`, `job is {status}; ' +
              'only finished jobs can be references` or `job has no document output`.',
          ),
          404: error('`document type not found`.'),
          409: error(
            '`the draft changed after this run; run it again`, or `reference "{name}" ' +
              'already exists`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const body = CreateReference.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (!(await typeExists(req.params.id))) {
        return reply.code(404).send({ error: 'document type not found' });
      }
      const job = await app.deps.repo.getJob(body.data.jobId);
      if (!job || job.specId !== req.params.id) {
        return reply.code(400).send({ error: `job is not a ${req.params.id} document` });
      }
      if (job.status !== 'succeeded') {
        return reply
          .code(400)
          .send({ error: `job is ${job.status}; only finished jobs can be references` });
      }
      const document = await jobDocument(app, job);
      if (!document) return reply.code(400).send({ error: 'job has no document output' });
      // Workbench types pin references to the version, and remember the outputs the run was
      // checked against.
      let pin: { templateVersion: number; verifiedOutputs: unknown } | null = null;
      if (await app.deps.workbench.getProject(req.params.id)) {
        const verifiedOutputs = await runOutputs(job);
        if (verifiedOutputs === STALE) {
          return reply.code(409).send({ error: 'the draft changed after this run; run it again' });
        }
        pin = { templateVersion: job.specVersion, verifiedOutputs };
      }
      try {
        // Carry earlier references forward first, or a save made before anyone opened the
        // References tab would give this version references of its own and hide the earlier set.
        if (pin) await app.deps.repo.carryReferencesForward(req.params.id, job.specVersion);
        const reference = await app.deps.repo.createReference({
          templateId: req.params.id,
          name: body.data.name,
          documentId: job.documentId,
          sourceJobId: job.id,
          expected: expectedFromDocument(document),
          ...pin,
        });
        return reply.code(201).send(reference);
      } catch (err) {
        if (err instanceof ReferenceConflictError)
          return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; ref: string } }>(
    '/templates/:id/references/:ref',
    {
      schema: {
        tags: ['References & regression'],
        operationId: 'deleteReference',
        summary: 'Delete a reference',
        description: md`
          Removes a reference from the document type's live set. A reference pinned to a version
          (Workbench types) is marked superseded rather than deleted, so earlier evaluations keep
          their comparisons; an unpinned one is deleted.
        `,
        params: z.object({
          id: z.string().describe('The document type id.'),
          ref: z.string().uuid().describe('The reference id.'),
        }),
        response: {
          204: noContent('Deleted or superseded.'),
          404: error('`reference not found`.'),
        },
      },
    },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.ref).success) {
        return reply.code(404).send({ error: 'reference not found' });
      }
      const deleted = await app.deps.repo.deleteReference(req.params.id, req.params.ref);
      return deleted
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'reference not found' });
    },
  );

  /** Re-run every reference against a version (test jobs, never published). */
  app.post<{ Params: { id: string; version: string } }>(
    '/templates/:id/versions/:version/regression',
    {
      preHandler: refuseRetired(app),
      schema: {
        tags: ['References & regression'],
        operationId: 'runRegression',
        summary: 'Run a version against its references',
        description: md`
          Queues one test job per reference of the version (see \`GET …/references?version=\`),
          processing the reference's PDF with this version. Regression jobs are never delivered.
          Read the scores with \`GET …/regression\` once they finish.
        `,
        params: VersionParams,
        response: {
          201: res('The queued jobs.', z.object({ jobs: z.array(JobSummarySchema) })),
          400: error('`no references yet: save a reviewed job as a reference first`.'),
          404: error('`recipe version not found`.'),
          409: error(RETIRED_DOC + '.'),
        },
      },
    },
    async (req, reply) => {
      const version = Number(req.params.version);
      const record = await app.deps.templates.get(req.params.id, version);
      if (!record) return reply.code(404).send({ error: 'recipe version not found' });
      const references = await versionReferences(app, req.params.id, version);
      if (!references.length) {
        return reply
          .code(400)
          .send({ error: 'no references yet: save a reviewed job as a reference first' });
      }
      // A draft can change after the run: snapshot the outputs it was run against.
      const params = record.status === 'draft' ? draftOutputsSnapshot(record.definition) : null;
      const jobs = [];
      for (const reference of references) {
        jobs.push(
          await app.deps.repo.createRegressionJob(
            reference,
            version,
            params,
            creatorOf(req),
          ),
        );
      }
      return reply.code(201).send({ jobs });
    },
  );

  /** Latest regression job per reference for a version, with its comparison once finished. */
  app.get<{ Params: { id: string; version: string } }>(
    '/templates/:id/versions/:version/regression',
    {
      schema: {
        tags: ['References & regression'],
        operationId: 'getRegression',
        summary: "Get a version's regression results",
        description: md`
          For each reference of the version, its latest regression job and, once the job has
          finished, the comparison of expected and actual values: per field, and per table the
          matched, missing, extra and changed rows and cell counts. \`score\` is (matched
          fields + equal cells) / (fields + cells); 1 means identical. The summary averages the
          completed scores.
        `,
        params: VersionParams,
        response: { 200: res('The regression report.', RegressionReportSchema) },
      },
    },
    async (req) => {
      const { items, summary } = await regressionReport(
        app,
        req.params.id,
        Number(req.params.version),
      );
      return { items, summary };
    },
  );

  /** Structural diff between two versions of a document type. */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/templates/:id/diff',
    {
      schema: {
        tags: ['References & regression'],
        operationId: 'diffTemplates',
        summary: 'Compare two versions',
        description: md`
          The structural changes from one version to another. Sections, fields, tables, columns
          and steps are matched by id, so a moved or inserted item is one change, not a cascade.
        `,
        params: TypeParams,
        querystring: z.object({
          from: z.string().describe('The earlier version number.'),
          to: z.string().describe('The later version number.'),
        }),
        response: {
          200: res(
            'The changes.',
            z.object({
              from: z.number().int(),
              to: z.number().int(),
              changes: z.array(ChangeSchema),
            }),
          ),
          404: error('`recipe version not found`: either version is missing.'),
        },
      },
    },
    async (req, reply) => {
      const [from, to] = await Promise.all([
        app.deps.templates.get(req.params.id, Number(req.query.from)),
        app.deps.templates.get(req.params.id, Number(req.query.to)),
      ]);
      if (!from || !to) return reply.code(404).send({ error: 'recipe version not found' });
      return {
        from: from.version,
        to: to.version,
        changes: diffDefinitions(from.definition, to.definition),
      };
    },
  );

  /** Operational metrics for a document type: per version, per step, most-edited targets. */
  app.get<{ Params: { id: string } }>(
    '/templates/:id/metrics',
    {
      schema: {
        tags: ['References & regression'],
        operationId: 'getTemplateMetrics',
        summary: "Get a document type's operational metrics",
        description: md`
          How a document type performs in production, from its jobs: per version, job counts by
          status, review rate, edits per reviewed document and processing time (test runs
          counted separately); per step, model calls, re-runs, failures, attempts, output tokens
          and time (cached Workbench steps left out); and the most edited fields and columns.
        `,
        params: TypeParams,
        response: { 200: res('The metrics.', TemplateMetricsSchema) },
      },
    },
    async (req) => computeMetrics(req.params.id, await app.deps.repo.metricsData(req.params.id)),
  );
};
