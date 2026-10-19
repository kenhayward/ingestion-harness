import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  PluginPreviewBodySchema,
  PluginPreviewResultSchema,
  PluginPreviewViewSchema,
  pluginPreviewKey,
  TemplateSchema,
  type PluginPreviewResult,
  type PluginPreviewView,
} from '@ih/shared';
import { error, md, res } from '../openapi/zod.js';
import type { PluginJobParams, ProjectJob } from '../repositories/types.js';
import {
  PROJECT_NOT_FOUND,
  ProjectIdParams,
  readJsonSafe,
  sampleViews,
  versionsOf,
} from './workbench.js';

/** Plugin step previews (recipe plugins 3c): a plugin step run on the prepared dev samples. */

const view = (job: ProjectJob, result: PluginPreviewResult | null): PluginPreviewView => ({
  jobId: job.id,
  status: job.status,
  error: job.error,
  result,
});

export const workbenchPluginPreviewRoutes: FastifyPluginAsync = async (app) => {
  const { workbench, templates } = app.deps;

  app.post<{ Params: { id: string } }>(
    '/workbench/projects/:id/plugin-previews',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'previewPluginStep',
        summary: 'Preview a plugin step on the dev samples',
        description: md`
          Queues a plugin step preview: the worker runs the open draft's plugin step \`stepId\`
          on each chosen dev sample's prepared text, cut into sections as production does, and
          types its reply as a run would (without earlier steps' values: a preview runs no other
          step). It runs in a child process with a time limit, so a runaway pattern cannot stall
          the worker. \`sampleIds\` defaults to every ready dev sample. Poll
          \`GET …/plugin-previews/{jobId}\`. A project has one preview at a time: a new one
          replaces the old. Only plugins that send no data out can be previewed.
        `,
        params: ProjectIdParams,
        body: PluginPreviewBodySchema,
        response: {
          202: res('The queued preview.', PluginPreviewViewSchema),
          400: error(
            'Zod issues, `the recipe is not valid`, `no plugin step … in the recipe`, `unknown sample …` or `plugin previews use dev samples only`.',
          ),
          404: PROJECT_NOT_FOUND,
          409: error(
            "`no plugin … on this deployment's workers`, `only plugins that send no data out can be previewed yet`, `… is not prepared` or `no prepared dev samples to preview: add samples first`.",
          ),
        },
      },
    },
    async (req, reply) => {
      const projectId = req.params.id;
      if (!(await workbench.getProject(projectId))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const body = PluginPreviewBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { draft, latest } = await versionsOf(templates, projectId);
      const record = draft !== null ? await templates.get(projectId, draft) : latest;
      const parsed = TemplateSchema.safeParse(record?.definition);
      if (!record || !parsed.success) {
        return reply.code(400).send({ error: 'the recipe is not valid' });
      }
      const step = parsed.data.pipeline.find(
        (s) => s.type === 'plugin' && s.id === body.data.stepId,
      );
      if (!step || step.type !== 'plugin') {
        return reply.code(400).send({ error: `no plugin step ${body.data.stepId} in the recipe` });
      }
      const plugin = (await app.deps.plugins?.list())?.find((p) => p.ref === step.uses);
      if (!plugin) {
        return reply
          .code(409)
          .send({ error: `no plugin ${step.uses} on this deployment's workers` });
      }
      if (plugin.egress !== 'none') {
        return reply
          .code(409)
          .send({ error: 'only plugins that send no data out can be previewed yet' });
      }

      const views = await sampleViews(app, projectId);
      let chosen: { id: string; filename: string; sha256: string }[];
      if (body.data.sampleIds) {
        chosen = [];
        for (const id of new Set(body.data.sampleIds)) {
          const sample = views.find((s) => s.record.id === id);
          if (!sample) return reply.code(400).send({ error: `unknown sample ${id}` });
          if (sample.view.role !== 'dev') {
            return reply.code(400).send({ error: 'plugin previews use dev samples only' });
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
      if (!chosen.length) {
        return reply
          .code(409)
          .send({ error: 'no prepared dev samples to preview: add samples first' });
      }

      const params: PluginJobParams = {
        stepId: step.id,
        definition: record.definition,
        samples: chosen.map((s) => ({ sampleId: s.id, fileName: s.filename, sha256: s.sha256 })),
      };
      const { job, removed } = await app.deps.repo.createPluginJob(projectId, params);
      await Promise.all(
        removed.map((id) =>
          app.deps.store
            .delete(app.deps.buckets.runs, pluginPreviewKey(projectId, id))
            .catch((err: unknown) => req.log.warn({ err, id }, 'old plugin preview not deleted')),
        ),
      );
      return reply.code(202).send(view(job, null));
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    '/workbench/projects/:id/plugin-previews/:jobId',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'getPluginPreview',
        summary: 'Get a plugin step preview',
        description: md`
          A preview's status and, once it succeeded, each sample's typed values (or rows), the
          values that could not be typed, and why a sample could not be previewed; \`problem\`
          when the preview could not run at all (bad settings, past its time limit).
          \`error: result missing\` when the result file is gone.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          jobId: z.string().uuid().describe('The preview job id.'),
        }),
        response: {
          200: res('The preview.', PluginPreviewViewSchema),
          404: error('`plugin preview not found`.'),
        },
      },
    },
    async (req, reply) => {
      const jobId = z.string().uuid().safeParse(req.params.jobId);
      const job = jobId.success
        ? await app.deps.repo.getPluginJob(req.params.id, jobId.data)
        : null;
      if (!job) return reply.code(404).send({ error: 'plugin preview not found' });
      if (job.status !== 'succeeded') return view(job, null);
      const raw = await readJsonSafe(app, pluginPreviewKey(job.projectId, job.id));
      const result = raw ? PluginPreviewResultSchema.safeParse(raw) : null;
      if (!result?.success) return { ...view(job, null), error: 'result missing' };
      return view(job, result.data);
    },
  );
};
