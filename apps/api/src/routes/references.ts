import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { expectedFromDocument } from '../regression/compare.js';
import { jobDocument, regressionReport, versionReferences } from '../regression/report.js';
import { diffDefinitions } from '../regression/diff.js';
import { computeMetrics } from '../metrics.js';
import { ReferenceConflictError } from '../repositories/types.js';

const ListQuery = z
  .object({ version: z.coerce.number().int().positive().optional() })
  .strict();

const CreateReference = z
  .object({ jobId: z.string().uuid(), name: z.string().min(1).max(100) })
  .strict();

export const referenceRoutes: FastifyPluginAsync = async (app) => {
  const typeExists = async (id: string) =>
    (await app.deps.templates.list()).some((r) => r.id === id);

  app.get<{ Params: { id: string } }>('/templates/:id/references', async (req, reply) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues });
    return app.deps.repo.listReferences(req.params.id, query.data.version);
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
    // Workbench types pin references to the version they were verified against.
    const pin = (await app.deps.workbench.getProject(req.params.id))
      ? {
          templateVersion: job.specVersion,
          verifiedOutputs:
            ((await app.deps.templates.get(req.params.id, job.specVersion))?.definition as
              | { outputs?: unknown }
              | undefined)?.outputs ?? null,
        }
      : null;
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
      if (!(await app.deps.templates.get(req.params.id, version))) {
        return reply.code(404).send({ error: 'template version not found' });
      }
      const references = await versionReferences(app, req.params.id, version);
      if (!references.length) {
        return reply
          .code(400)
          .send({ error: 'no references yet: save a reviewed job as a reference first' });
      }
      const jobs = [];
      for (const reference of references) {
        jobs.push(await app.deps.repo.createRegressionJob(reference, version));
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
