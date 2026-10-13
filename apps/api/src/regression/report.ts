import type { FastifyInstance } from 'fastify';
import { outputChanges, type JobDetail, type Reference } from '@ih/shared';
import { compareToReference, type RunDocument } from './compare.js';

async function readJson(app: FastifyInstance, bucket: string, key: string) {
  const body = await app.deps.store.get(bucket, key);
  return body ? (JSON.parse(body.toString('utf8')) as RunDocument) : null;
}

/**
 * The document a job produced: the reviewed version if it was reviewed, else its draft. With
 * `raw`, always the draft (what the models extracted, before any review edit).
 */
export async function jobDocument(
  app: FastifyInstance,
  job: JobDetail,
  { raw = false }: { raw?: boolean } = {},
): Promise<RunDocument | null> {
  if (!raw) {
    const reviewed = await readJson(app, app.deps.buckets.runs, `${job.id}/reviewed-document.json`);
    if (reviewed) return reviewed;
  }
  const draft = job.outputs.find((o) => o.stage === 'draft' && o.outputId === 'document');
  return draft ? readJson(app, draft.bucket, draft.key) : null;
}

/** A regression run has a document to compare once it finished (or stopped for review). */
export const regressionFinished = (status: string) =>
  status === 'succeeded' || status === 'awaiting_review';

/** Latest regression job per reference for a version, with its comparison once finished. */
export async function regressionReport(
  app: FastifyInstance,
  templateId: string,
  version: number,
  /** Pass when already loaded (the templates list reads them for its summary too). */
  known?: Reference[],
) {
  const references = known ?? (await versionReferences(app, templateId, version));
  const jobs = await app.deps.repo.listLatestRegressionJobs(templateId, version);
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

/**
 * The references a version is regression-tested against: live ones pinned to it or unpinned,
 * minus those verified against outputs this version has changed (re-verify them first).
 */
export async function versionReferences(
  app: FastifyInstance,
  templateId: string,
  version: number,
): Promise<Reference[]> {
  const [references, record] = await Promise.all([
    app.deps.repo.listReferences(templateId, version),
    app.deps.templates.get(templateId, version),
  ]);
  const outputs = (record?.definition as { outputs?: unknown } | undefined)?.outputs ?? null;
  return references.filter((r) => outputChanges(r.verifiedOutputs, outputs).length === 0);
}
