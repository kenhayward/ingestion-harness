import type { FastifyInstance } from 'fastify';
import type { JobDetail } from '@ih/shared';
import { compareToReference, type RunDocument } from './compare.js';

async function readJson(app: FastifyInstance, bucket: string, key: string) {
  const body = await app.deps.store.get(bucket, key);
  return body ? (JSON.parse(body.toString('utf8')) as RunDocument) : null;
}

/** The document a job produced: the reviewed version if it was reviewed, else its draft. */
export async function jobDocument(
  app: FastifyInstance,
  job: JobDetail,
): Promise<RunDocument | null> {
  const reviewed = await readJson(app, app.deps.buckets.runs, `${job.id}/reviewed-document.json`);
  if (reviewed) return reviewed;
  const draft = job.outputs.find((o) => o.stage === 'draft' && o.outputId === 'document');
  return draft ? readJson(app, draft.bucket, draft.key) : null;
}

/** A regression run has a document to compare once it finished (or stopped for review). */
export const regressionFinished = (status: string) =>
  status === 'succeeded' || status === 'awaiting_review';

/** Latest regression job per reference for a version, with its comparison once finished. */
export async function regressionReport(app: FastifyInstance, templateId: string, version: number) {
  const references = await app.deps.repo.listReferences(templateId);
  const jobs = await app.deps.repo.listRegressionJobs(templateId, version);
  const items = await Promise.all(
    references.map(async (reference) => {
      const job = jobs.find((j) => j.referenceId === reference.id) ?? null;
      const document = job && regressionFinished(job.status) ? await jobDocument(app, job) : null;
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
    jobs,
    summary: {
      references: references.length,
      completed: scores.length,
      averageScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    },
  };
}
