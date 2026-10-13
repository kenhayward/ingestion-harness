import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { JobDetail } from '@ih/shared';
import { expectedFromDocument } from '../regression/compare.js';
import { jobDocument, regressionReport, versionReferences } from '../regression/report.js';
import { diffDefinitions } from '../regression/diff.js';
import { computeMetrics } from '../metrics.js';
import { ReferenceConflictError } from '../repositories/types.js';
import { draftOutputsSnapshot } from '../templates/definitions.js';

const STALE = Symbol('stale');

const ListQuery = z.object({ version: z.coerce.number().int().positive().optional() }).strict();

const CreateReference = z
  .object({ jobId: z.string().uuid(), name: z.string().min(1).max(100) })
  .strict();

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

  app.get<{ Params: { id: string } }>('/templates/:id/references', async (req, reply) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues });
    const { version } = query.data;
    // With a version: the set regression runs against (outdated references left out).
    return version === undefined
      ? app.deps.repo.listReferences(req.params.id)
      : versionReferences(app, req.params.id, version);
  });

  /** Save a finished job's (reviewed) values as the expected result for this document type. */
  app.post<{ Params: { id: string } }>('/templates/:id/references', async (req, reply) => {
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
  });

  app.delete<{ Params: { id: string; ref: string } }>(
    '/templates/:id/references/:ref',
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
    async (req, reply) => {
      const version = Number(req.params.version);
      const record = await app.deps.templates.get(req.params.id, version);
      if (!record) return reply.code(404).send({ error: 'template version not found' });
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
        jobs.push(await app.deps.repo.createRegressionJob(reference, version, params));
      }
      return reply.code(201).send({ jobs });
    },
  );

  /** Latest regression job per reference for a version, with its comparison once finished. */
  app.get<{ Params: { id: string; version: string } }>(
    '/templates/:id/versions/:version/regression',
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
    async (req, reply) => {
      const [from, to] = await Promise.all([
        app.deps.templates.get(req.params.id, Number(req.query.from)),
        app.deps.templates.get(req.params.id, Number(req.query.to)),
      ]);
      if (!from || !to) return reply.code(404).send({ error: 'template version not found' });
      return {
        from: from.version,
        to: to.version,
        changes: diffDefinitions(from.definition, to.definition),
      };
    },
  );

  /** Operational metrics for a document type: per version, per step, most-edited targets. */
  app.get<{ Params: { id: string } }>('/templates/:id/metrics', async (req) =>
    computeMetrics(req.params.id, await app.deps.repo.metricsData(req.params.id)),
  );
};
