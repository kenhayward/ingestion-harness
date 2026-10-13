import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  DraftResultSchema,
  ProjectOverviewSchema,
  briefSaved,
  draftingKey,
  overviewItems,
  overviewNext,
  type ChangeBody,
  type DraftStage,
  type GateView,
  type MetricFacts,
  type OverviewInputs,
  type ProjectOverview,
  type ProjectView,
  type WorkbenchProject,
} from '@ih/shared';
import type { IterationRecord, ProposalRecord } from '../workbench/repo.js';
import { md, res } from '../openapi/zod.js';
import {
  PROJECT_NOT_FOUND,
  ProjectIdParams,
  acceptedSurvey,
  allStages,
  gateFor,
  parseBody,
  projectView,
  readJsonSafe,
  referenceRows,
  sampleViews,
  statusOf,
  type SampleViews,
} from './workbench.js';

/** A proposal's stored result: its model and change body, or null when missing or unreadable. */
async function changeResult(
  app: FastifyInstance,
  p: ProposalRecord | undefined,
): Promise<{ model: string; body: ChangeBody } | null> {
  if (!p) return null;
  try {
    const raw = await readJsonSafe(app, draftingKey(p.projectId, p.id));
    const parsed = raw == null ? null : DraftResultSchema.safeParse(raw);
    const body = parsed?.success ? parseBody(p.stage, parsed.data.body) : null;
    return parsed?.success && body && 'changes' in body ? { model: parsed.data.model, body } : null;
  } catch {
    return null; // a store outage leaves the figure empty; the overview still answers
  }
}

const count = (x: unknown) => (Array.isArray(x) ? x.length : 0);
/** `local/qwen3.8-27b-mtp` → `qwen3.8-27b-mtp`. */
const modelName = (ref: string) => ref.slice(ref.indexOf('/') + 1);

/** The figures of each Overview map box (handoff §3), from what the overview already loaded. */
async function gatherFacts(
  app: FastifyInstance,
  ctx: {
    view: ProjectView;
    samples: SampleViews;
    proposals: ProposalRecord[];
    iterations: IterationRecord[];
    gate: GateView;
    runs: { total: number; awaitingReview: number };
    openFeedback: number;
  },
): Promise<MetricFacts> {
  const { view, samples, proposals, iterations, gate } = ctx;
  const id = view.project.id;
  // Newest first (`listProposals`).
  const newest = (stage: DraftStage, decided = false) =>
    proposals.find((p) => p.stage === stage && (!decided || p.decision !== null));
  // The newest proposal of a stage whose result is readable: a newer one still drafting (no
  // body yet) or unreadable does not blank the figures.
  const newestReadable = async (stage: DraftStage) => {
    for (const p of proposals.filter((p) => p.stage === stage)) {
      const result = await changeResult(app, p);
      if (result) return result;
    }
    return null;
  };
  const outputsProposal = newest('outputs', true);
  const version = view.draft ?? view.published;
  const [template, survey, outputsResult, sectionsResult, stepsResult, dev, holdout] =
    await Promise.all([
      version === null ? null : app.deps.templates.get(id, version),
      acceptedSurvey(app, id).catch(() => null),
      changeResult(app, outputsProposal),
      newestReadable('sections'),
      newestReadable('steps'),
      referenceRows(app, id, 'dev', samples),
      referenceRows(app, id, 'holdout', samples),
    ]);

  const ready = samples.filter((s) => s.view.state === 'ready');
  const devIds = new Set(ready.filter((s) => s.record.role === 'dev').map((s) => s.record.id));
  const answers = view.brief?.body.answers ?? [];
  const answered = answers.filter((a) => a.answer.trim() !== '').length;
  const definition = (template?.definition ?? {}) as {
    pipeline?: unknown;
    document?: { sections?: unknown };
    outputs?: { fields?: unknown; tables?: unknown };
  };
  const verified = (rows: typeof dev) =>
    rows.filter((r) => r.reference !== null && r.reference.outdated.length === 0).length;
  const changes = outputsResult?.body.changes.length ?? null;
  const applied =
    outputsProposal === undefined || changes === null
      ? null
      : (outputsProposal.acceptedChanges?.length ??
        (outputsProposal.decision === 'accepted' ? changes : 0));
  const anchorCheck = sectionsResult?.body.anchorCheck ?? null;
  // Newest first (`listIterations`); `scores` is cached once every job has finished.
  const evaluated = iterations.find(
    (i) =>
      i.set === 'dev' && i.model === null && i.templateVersion === view.draft && i.scores !== null,
  );
  return {
    samples: {
      dev: samples.filter((s) => s.record.role === 'dev').length,
      holdout: samples.filter((s) => s.record.role === 'holdout').length,
      ocrPages: ready.reduce((n, s) => n + (s.view.triage?.ocrPages.length ?? 0), 0),
      pages: ready.reduce((n, s) => n + (s.view.triage?.pageCount ?? 0), 0),
    },
    brief: { answers: answered, updatedAt: view.brief?.createdAt ?? null },
    template: {
      steps: count(definition.pipeline),
      sections: count(definition.document?.sections),
      editedAt: template?.updatedAt ?? template?.createdAt ?? null,
    },
    runs: ctx.runs,
    survey: {
      answered,
      questions: answers.length,
      fields: survey ? survey.candidates.filter((c) => c.kind === 'field').length : null,
      tables: survey ? survey.candidates.filter((c) => c.kind === 'table').length : null,
    },
    outputs: {
      fields: count(definition.outputs?.fields),
      tables: count(definition.outputs?.tables),
      applied,
      proposed: applied === null ? null : changes,
    },
    sections: {
      anchorsFound:
        anchorCheck === null
          ? null
          : anchorCheck.samples.filter(
              (s) => devIds.has(s.sampleId) && s.error === null && s.missingRequired.length === 0,
            ).length,
      devSamples: devIds.size,
    },
    steps: {
      proposed: stepsResult?.body.changes.length ?? null,
      model: stepsResult ? modelName(stepsResult.model) : null,
    },
    references: {
      devVerified: verified(dev),
      devTotal: dev.length,
      holdoutVerified: verified(holdout),
      holdoutTotal: holdout.length,
    },
    evaluate: { dev: evaluated?.scores?.score ?? null, holdout: gate.score },
    revise: { open: ctx.openFeedback, lastAt: newest('revise')?.createdAt ?? null },
    publish: { live: view.published },
  };
}

/**
 * Everything the project page's rail, header and Overview tab show, in one call (handoff W2).
 * Revise counts only proposals made since the latest publication: an older one answered an
 * earlier version. The cut-off is strict: a proposal created at exactly the publication time
 * counts as earlier.
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
  const states = samples.map((s) => s.view.state);
  const inputs: OverviewInputs = {
    draft: view.draft,
    published: view.published,
    briefSaved: briefSaved(view.brief),
    samples: {
      total: states.length,
      preparing: states.filter((s) => s === 'preparing').length,
      failed: states.filter((s) => s === 'failed').length,
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
  const runCounts = {
    total: runs.length,
    unfinished: runs.filter((j) => j.status === 'queued' || j.status === 'running').length,
    awaitingReview: runs.filter((j) => j.status === 'awaiting_review').length,
  };
  const openFeedback = feedback.filter((f) => f.resolvedBy === null).length;
  const facts = await gatherFacts(app, {
    view,
    samples,
    proposals,
    iterations,
    gate,
    runs: { total: runCounts.total, awaitingReview: runCounts.awaitingReview },
    openFeedback,
  });
  return {
    project: view,
    stages: overviewItems({
      inputs,
      briefVersion: view.brief?.version ?? null,
      runs: runCounts,
      openFeedback,
      facts,
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
