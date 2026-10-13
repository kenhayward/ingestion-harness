import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  ProjectOverviewSchema,
  briefSaved,
  overviewItems,
  overviewNext,
  type OverviewInputs,
  type ProjectOverview,
  type WorkbenchProject,
} from '@ih/shared';
import { md, res } from '../openapi/zod.js';
import {
  PROJECT_NOT_FOUND,
  ProjectIdParams,
  allStages,
  gateFor,
  projectView,
  sampleViews,
  statusOf,
} from './workbench.js';

/**
 * Everything the project page's rail, header and Overview tab show, in one call (handoff W2).
 * Revise counts only proposals made since the latest publication: an older one answered an
 * earlier version.
 */
export async function projectOverview(
  app: FastifyInstance,
  project: WorkbenchProject,
): Promise<ProjectOverview> {
  const { workbench, repo } = app.deps;
  const id = project.id;
  const [
    view,
    samples,
    stages,
    gate,
    proposals,
    draftJobs,
    iterations,
    jobs,
    feedback,
    publications,
  ] = await Promise.all([
    projectView(app, project),
    sampleViews(app, id),
    allStages(app, id),
    gateFor(app, project),
    workbench.listProposals(id),
    repo.listDraftJobs(id),
    workbench.listIterations(id),
    repo.listProjectJobs(id),
    workbench.listFeedback(id),
    workbench.listPublications(id),
  ]);
  const since =
    publications
      .map((p) => p.publishedAt)
      .sort()
      .at(-1) ?? '';
  const draftJob = new Map(draftJobs.map((j) => [j.id, j]));
  const revise = proposals
    .filter((p) => p.stage === 'revise' && p.createdAt > since)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const active = (jobId: string) => {
    const status = jobById.get(jobId)?.status;
    return status === 'queued' || status === 'running';
  };
  const runs = jobs.filter((j) => j.task !== 'prepare');
  const inputs: OverviewInputs = {
    draft: view.draft,
    published: view.published,
    briefSaved: briefSaved(view.brief),
    samples: {
      total: samples.length,
      preparing: samples.filter((s) => s.view.state === 'preparing').length,
      failed: samples.filter((s) => s.view.state === 'failed').length,
    },
    stages,
    revise: revise ? statusOf(revise, draftJob.get(revise.id) ?? null) : null,
    evaluation: {
      running:
        view.draft !== null &&
        iterations.some((i) => i.templateVersion === view.draft && i.jobIds.some(active)),
    },
    gate: {
      threshold: gate.threshold,
      iterationId: gate.iterationId,
      score: gate.score,
      passes: gate.passes,
      reason: gate.reason,
    },
  };
  return {
    project: view,
    stages: overviewItems({
      inputs,
      briefVersion: view.brief?.version ?? null,
      runs: {
        total: runs.length,
        unfinished: runs.filter((j) => j.status === 'queued' || j.status === 'running').length,
        awaitingReview: runs.filter((j) => j.status === 'awaiting_review').length,
      },
      openFeedback: feedback.filter((f) => f.resolvedBy === null).length,
    }),
    next: overviewNext(inputs),
    gate: inputs.gate,
  };
}

/** GET /api/workbench/projects/:id/overview (Workbench redesign, W2). */
export const workbenchOverviewRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    '/workbench/projects/:id/overview',
    {
      schema: {
        tags: ['Projects & data policy'],
        operationId: 'getProjectOverview',
        summary: "Get a project's overview",
        description: md`
          Everything the project page shows around its tabs, in one call: the project, each
          tab's state and status text (the ten stages, then Template and Test runs), the most
          urgent next step, and the publish gate. Poll it while any stage is running.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The overview.', ProjectOverviewSchema),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const project = await app.deps.workbench.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      return projectOverview(app, project);
    },
  );
};
