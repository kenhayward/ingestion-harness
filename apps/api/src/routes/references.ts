import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { JobDetail } from '@ih/shared';
import { z } from 'zod';
import {
  compareToReference,
  expectedFromDocument,
  type RunDocument,
} from '../regression/compare.js';
import { diffDefinitions } from '../regression/diff.js';
import { ReferenceConflictError } from '../repositories/types.js';

const CreateReference = z
  .object({ jobId: z.string().uuid(), name: z.string().min(1).max(100) })
  .strict();

async function readJson(app: FastifyInstance, bucket: string, key: string) {
  const body = await app.deps.store.get(bucket, key);
  return body ? (JSON.parse(body.toString('utf8')) as RunDocument) : null;
}

/** The document a job produced: the reviewed version if it was reviewed, else its draft. */
async function jobDocument(app: FastifyInstance, job: JobDetail): Promise<RunDocument | null> {
  const reviewed = await readJson(app, app.deps.buckets.runs, `${job.id}/reviewed-document.json`);
  if (reviewed) return reviewed;
  const draft = job.outputs.find((o) => o.stage === 'draft' && o.outputId === 'document');
  return draft ? readJson(app, draft.bucket, draft.key) : null;
}

export const referenceRoutes: FastifyPluginAsync = async (app) => {
  const typeExists = async (id: string) =>
    (await app.deps.templates.list()).some((r) => r.id === id);

  app.get<{ Params: { id: string } }>('/templates/:id/references', async (req) =>
    app.deps.repo.listReferences(req.params.id),
  );

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
    try {
      const reference = await app.deps.repo.createReference({
        templateId: req.params.id,
        name: body.data.name,
        documentId: job.documentId,
        sourceJobId: job.id,
        expected: expectedFromDocument(document),
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
      const references = await app.deps.repo.listReferences(req.params.id);
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
      const version = Number(req.params.version);
      const references = await app.deps.repo.listReferences(req.params.id);
      const jobs = await app.deps.repo.listRegressionJobs(req.params.id, version);
      const items = await Promise.all(
        references.map(async (reference) => {
          const job = jobs.find((j) => j.referenceId === reference.id) ?? null;
          const ready = job && (job.status === 'succeeded' || job.status === 'awaiting_review');
          const document = ready ? await jobDocument(app, job) : null;
          return {
            reference: { id: reference.id, name: reference.name },
            job: job && { id: job.id, status: job.status, error: job.error },
            comparison: document ? compareToReference(reference.expected, document) : null,
          };
        }),
      );
      const scores = items.flatMap((i) => (i.comparison ? [i.comparison.score] : []));
      return {
        items,
        summary: {
          references: references.length,
          completed: scores.length,
          averageScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        },
      };
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
};
