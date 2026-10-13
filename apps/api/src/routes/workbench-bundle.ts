import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { EMPTY_BRIEF, exportKey, type ExportView } from '@ih/shared';
import type { ProjectJob } from '../repositories/types.js';
import { acceptedSurvey, isAdmin, sampleViews, versionsOf } from './workbench.js';

/**
 * Drafting bundles (Workbench phase 6): a zip of the drafting context and the dev samples, built
 * by the worker's `export` task, so drafting can continue in another tool.
 */
const LOCAL_EXPORT = 'exporting a local-only project needs the admin token';
const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const JobParams = z.object({ id: Id, jobId: z.string().uuid() });
/** The template version the export carried (`draft` is the definition it was built from). */
const ExportedVersion = z.object({ draft: z.object({ version: z.number().int() }) });

const exportView = (j: ProjectJob): ExportView => ({
  jobId: j.id,
  status: j.status,
  error: j.error,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt,
});

export const workbenchBundleRoutes: FastifyPluginAsync = async (app) => {
  const { repo, store, buckets, templates, workbench } = app.deps;

  app.post<{ Params: { id: string } }>('/workbench/projects/:id/export', async (req, reply) => {
    const { id } = req.params;
    const project = await workbench.getProject(id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    // The bundle carries sample PDFs and text out of the harness: like allowing external models.
    if (project.dataPolicy === 'local' && !isAdmin(app, req)) {
      return reply.code(403).send({ error: LOCAL_EXPORT });
    }
    const { draft, latest } = await versionsOf(templates, id);
    const record = draft !== null ? await templates.get(id, draft) : latest;
    if (!record) return reply.code(409).send({ error: 'the project has no template version' });
    // Holdout rule (ADR 0007): only dev samples leave, as in drafting.
    const samples = (await sampleViews(app, id))
      .filter((s) => s.view.role === 'dev' && s.view.state === 'ready')
      .map((s) => ({
        sampleId: s.record.id,
        filename: s.record.filename,
        sha256: s.record.sha256,
        role: 'dev' as const,
        bucket: s.record.bucket,
        objectKey: s.record.objectKey,
      }));
    if (!samples.length) return reply.code(409).send({ error: 'no prepared dev samples' });
    const brief = await workbench.latestBrief(id);
    const { job, removed } = await repo.createExportJob(id, {
      stage: 'export',
      dataPolicy: project.dataPolicy,
      projectName: project.name,
      briefVersion: brief?.version ?? null,
      brief: brief?.body ?? EMPTY_BRIEF,
      draft: record.definition,
      survey: await acceptedSurvey(app, id),
      samples,
    });
    for (const removedId of removed) await store.delete(buckets.runs, exportKey(id, removedId));
    req.log.info({ projectId: id, jobId: job.id, samples: samples.length }, 'bundle export queued');
    return reply.code(202).send(exportView(job));
  });

  app.get<{ Params: { id: string } }>('/workbench/projects/:id/exports', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return (await repo.listExportJobs(req.params.id)).map(exportView);
  });

  app.get<{ Params: { id: string; jobId: string } }>(
    '/workbench/projects/:id/exports/:jobId/bundle',
    async (req, reply) => {
      const params = JobParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'export not found' });
      const { id, jobId } = params.data;
      const project = await workbench.getProject(id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      if (project.dataPolicy === 'local' && !isAdmin(app, req)) {
        return reply.code(403).send({ error: LOCAL_EXPORT });
      }
      const job = (await repo.listExportJobs(id)).find((j) => j.id === jobId);
      if (!job) return reply.code(404).send({ error: 'export not found' });
      if (job.status !== 'succeeded') {
        return reply.code(409).send({ error: 'the export has not finished' });
      }
      const body = await store.get(buckets.runs, exportKey(id, jobId));
      if (!body) return reply.code(404).send({ error: 'bundle not found' });
      const exported = ExportedVersion.safeParse(await repo.getJobParams(jobId));
      const name = exported.success
        ? `${id}-v${exported.data.draft.version}-bundle.zip`
        : `${id}-bundle.zip`;
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${name}"`)
        .header('x-content-type-options', 'nosniff')
        .send(body);
    },
  );
};
