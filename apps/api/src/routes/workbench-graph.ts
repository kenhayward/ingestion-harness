import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  effectiveBaseIri,
  GraphPreviewBodySchema,
  GraphPreviewResultSchema,
  GraphPreviewViewSchema,
  graphPreviewKey,
  TemplateSchema,
  type GraphPreviewResult,
  type GraphPreviewView,
} from '@ih/shared';
import { error, md, res } from '../openapi/zod.js';
import type { GraphJobParams, ProjectJob } from '../repositories/types.js';
import {
  PROJECT_NOT_FOUND,
  ProjectIdParams,
  readJsonSafe,
  sampleViews,
  versionsOf,
} from './workbench.js';

/** Graph previews (ADR 0011): the open draft's ontology mapping rendered over finished runs. */

const FINISHED = new Set(['succeeded', 'awaiting_review']);
const NO_BASE = 'set the customer on the Linked data page';

const view = (job: ProjectJob, result: GraphPreviewResult | null): GraphPreviewView => ({
  jobId: job.id,
  status: job.status,
  error: job.error,
  result,
});

type Sample = GraphJobParams['samples'][number];

/** Each sample's newest finished test run and its draft document; null without one. */
async function finishedRuns(
  app: FastifyInstance,
  projectId: string,
  samples: { id: string; filename: string; sha256: string }[],
): Promise<Map<string, Sample | null>> {
  const runs = await app.deps.repo.listProjectRuns(projectId);
  const out = new Map<string, Sample | null>();
  for (const sample of samples) {
    let found: Sample | null = null;
    for (const run of runs.filter(
      (r) => r.sha256 === sample.sha256 && FINISHED.has(r.job.status),
    )) {
      const detail = await app.deps.repo.getJob(run.job.id);
      const doc = detail?.outputs.find((o) => o.outputId === 'document' && o.stage === 'draft');
      if (doc) {
        found = {
          sampleId: sample.id,
          jobId: run.job.id,
          fileName: sample.filename,
          sha256: sample.sha256,
          documentKey: doc.key,
        };
        break;
      }
    }
    out.set(sample.id, found);
  }
  return out;
}

export const workbenchGraphRoutes: FastifyPluginAsync = async (app) => {
  const { workbench, templates } = app.deps;

  app.post<{ Params: { id: string } }>(
    '/workbench/projects/:id/graph-previews',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'previewGraphs',
        summary: 'Preview the RDF graphs of the samples',
        description: md`
          Queues a graph preview: the worker renders the open draft's ontology mapping
          (\`semantics\`) over each chosen dev sample's newest finished test run (its reviewed
          document when it was approved, else its draft), under the deployment's base IRI, as
          production publishing would. \`sampleIds\` defaults to every ready dev sample with a
          finished run. Poll \`GET …/graph-previews/{jobId}\`. A project has one preview at a time:
          a new one replaces the old.
        `,
        params: ProjectIdParams,
        body: GraphPreviewBodySchema,
        response: {
          202: res('The queued preview.', GraphPreviewViewSchema),
          400: error(
            'Zod issues, `unknown sample …`, `graph previews use dev samples only`, or `the recipe is not valid`.',
          ),
          404: PROJECT_NOT_FOUND,
          409: error(
            '`set the customer on the Linked data page`, `the recipe has no ontology mapping: …`, `… is not prepared`, `… has no finished test run: run it first`, or `no finished test runs to preview: …`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const projectId = req.params.id;
      if (!(await workbench.getProject(projectId))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const body = GraphPreviewBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (effectiveBaseIri(await app.deps.linkedData.get()) === null) {
        return reply.code(409).send({ error: NO_BASE });
      }
      const { draft, latest } = await versionsOf(templates, projectId);
      const record = draft !== null ? await templates.get(projectId, draft) : latest;
      const parsed = TemplateSchema.safeParse(record?.definition);
      if (!record || !parsed.success) {
        return reply.code(400).send({ error: 'the recipe is not valid' });
      }
      if (!parsed.data.semantics) {
        return reply
          .code(409)
          .send({ error: 'the recipe has no ontology mapping: add one on the Mapping tab' });
      }

      const views = await sampleViews(app, projectId);
      let chosen: { id: string; filename: string; sha256: string }[];
      if (body.data.sampleIds) {
        chosen = [];
        for (const id of new Set(body.data.sampleIds)) {
          const sample = views.find((s) => s.record.id === id);
          if (!sample) return reply.code(400).send({ error: `unknown sample ${id}` });
          if (sample.view.role !== 'dev') {
            return reply.code(400).send({ error: 'graph previews use dev samples only' });
          }
          if (sample.view.state !== 'ready') {
            return reply.code(409).send({ error: `${sample.record.filename} is not prepared` });
          }
          chosen.push(sample.record);
        }
      } else {
        chosen = views
          .filter((s) => s.view.role === 'dev' && s.view.state === 'ready')
          .map((s) => s.record);
      }
      const runs = await finishedRuns(app, projectId, chosen);
      if (body.data.sampleIds) {
        const missing = chosen.find((s) => runs.get(s.id) === null);
        if (missing) {
          return reply
            .code(409)
            .send({ error: `${missing.filename} has no finished test run: run it first` });
        }
      }
      const samples = chosen.flatMap((s) => runs.get(s.id) ?? []);
      if (!samples.length) {
        return reply
          .code(409)
          .send({ error: 'no finished test runs to preview: run the samples first' });
      }

      const { job, removed } = await app.deps.repo.createGraphJob(projectId, {
        samples,
        definition: record.definition,
      });
      await Promise.all(
        removed.map((id) =>
          app.deps.store
            .delete(app.deps.buckets.runs, graphPreviewKey(projectId, id))
            .catch((err: unknown) => req.log.warn({ err, id }, 'old graph preview not deleted')),
        ),
      );
      return reply.code(202).send(view(job, null));
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    '/workbench/projects/:id/graph-previews/:jobId',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'getGraphPreview',
        summary: 'Get a graph preview',
        description: md`
          A preview's status and, once it succeeded, each sample's graph as Turtle with its
          triple count. \`error: result missing\` when the result file is gone.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          jobId: z.string().uuid().describe('The preview job id.'),
        }),
        response: {
          200: res('The preview.', GraphPreviewViewSchema),
          404: error('`graph preview not found`.'),
        },
      },
    },
    async (req, reply) => {
      const jobId = z.string().uuid().safeParse(req.params.jobId);
      const job = jobId.success ? await app.deps.repo.getGraphJob(req.params.id, jobId.data) : null;
      if (!job) return reply.code(404).send({ error: 'graph preview not found' });
      if (job.status !== 'succeeded') return view(job, null);
      const raw = await readJsonSafe(app, graphPreviewKey(job.projectId, job.id));
      const result = raw ? GraphPreviewResultSchema.safeParse(raw) : null;
      if (!result?.success) return { ...view(job, null), error: 'result missing' };
      return view(job, result.data);
    },
  );
};
