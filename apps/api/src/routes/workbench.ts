import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  MAX_SAMPLES,
  PreparedTextSchema,
  PreparedTriageSchema,
  SampleRoleSchema,
  inboxKey,
  preparedTextKey,
  preparedTriageKey,
  type JobSummary,
  type ProjectSummary,
  type ProjectView,
  type SampleState,
  type SampleView,
  type WorkbenchProject,
} from '@ih/shared';
import { createNextDraft, skeleton } from '../templates/drafts.js';
import type { TemplateRecord, TemplateRepo } from '../templates/repo.js';
import { isPdf, multipartField } from '../uploads.js';
import { WorkbenchConflictError, type SampleRecord } from '../workbench/repo.js';

const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase id: [a-z][a-z0-9_-]*');
const CreateProject = z.object({ id: Id, name: z.string().min(1).optional() }).strict();

type ProjectParams = { id: string };

/** The open draft, the latest published version and the newest record of a document type. */
export async function versionsOf(templates: TemplateRepo, id: string) {
  const versions = (await templates.list()).filter((r) => r.id === id);
  return {
    draft: versions.find((v) => v.status === 'draft')?.version ?? null,
    published: versions.filter((v) => v.status === 'published').at(-1)?.version ?? null,
    latest: (versions.at(-1) ?? null) as TemplateRecord | null,
  };
}

async function projectView(app: FastifyInstance, project: WorkbenchProject): Promise<ProjectView> {
  const { draft, published } = await versionsOf(app.deps.templates, project.id);
  return { project, draft, published, brief: await app.deps.workbench.latestBrief(project.id) };
}

const SampleParams = z.object({ id: Id, sid: z.string().uuid() });
const RoleBody = z.object({ role: SampleRoleSchema }).strict();

function stateOf(job: JobSummary | null): SampleState {
  if (job?.status === 'succeeded') return 'ready';
  if (job?.status === 'queued' || job?.status === 'running') return 'preparing';
  return 'failed';
}

async function readJson(app: FastifyInstance, key: string): Promise<unknown | null> {
  const raw = await app.deps.store.get(app.deps.buckets.runs, key);
  return raw ? (JSON.parse(raw.toString('utf8')) as unknown) : null;
}

/** Samples with their state, derived from each one's latest prepare job. */
export async function sampleViews(app: FastifyInstance, projectId: string) {
  const prepares = (await app.deps.repo.listProjectJobs(projectId)).filter(
    (j) => j.task === 'prepare',
  );
  const records = await app.deps.workbench.listSamples(projectId);
  return Promise.all(
    records.map(async (record) => ({
      record,
      view: await toView(
        app,
        record,
        prepares.find((j) => j.documentId === record.documentId) ?? null,
      ),
    })),
  );
}

async function toView(
  app: FastifyInstance,
  s: SampleRecord,
  job: JobSummary | null,
): Promise<SampleView> {
  const state = stateOf(job);
  const triage = state === 'ready' ? await readJson(app, preparedTriageKey(s.sha256)) : null;
  return {
    id: s.id,
    projectId: s.projectId,
    documentId: s.documentId,
    filename: s.filename,
    sizeBytes: s.sizeBytes,
    sha256: s.sha256,
    role: s.role,
    addedForVersion: s.addedForVersion,
    createdAt: s.createdAt,
    state,
    prepareJobId: job?.id ?? null,
    error: state === 'failed' ? (job?.error ?? job?.status ?? 'preparation job missing') : null,
    triage: triage === null ? null : PreparedTriageSchema.parse(triage),
  };
}

/** /api/workbench (ADR 0007, phase 1): projects, samples, brief, dev test runs. */
export const workbenchRoutes: FastifyPluginAsync = async (app) => {
  const { workbench, templates } = app.deps;

  app.get('/workbench/projects', async (): Promise<ProjectSummary[]> => {
    const projects = await workbench.listProjects();
    return Promise.all(
      projects.map(async (p) => {
        const { draft, published } = await versionsOf(templates, p.id);
        return { ...p, draft, published, samples: (await workbench.listSamples(p.id)).length };
      }),
    );
  });

  /** New project. An existing document type is opened: its open draft, or a new next draft. */
  app.post('/workbench/projects', async (req, reply) => {
    const body = CreateProject.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const { id } = body.data;
    if (await workbench.getProject(id)) {
      return reply.code(409).send({ error: `a workbench project for ${id} already exists` });
    }
    const { draft, latest } = await versionsOf(templates, id);
    let name = body.data.name;
    if (latest === null) {
      if (!name) return reply.code(400).send({ error: 'name is required for a new document type' });
      await templates.create(id, 1, skeleton(id, name), 'draft');
    } else {
      name = String(latest.definition.name ?? id);
      if (draft === null) await createNextDraft(templates, id);
    }
    try {
      const project = await workbench.createProject(id, name);
      return reply.code(201).send(await projectView(app, project));
    } catch (err) {
      if (err instanceof WorkbenchConflictError)
        return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id', async (req, reply) => {
    const project = await workbench.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return projectView(app, project);
  });

  const findSample = async (projectId: string, sampleId: string) =>
    (await sampleViews(app, projectId)).find((s) => s.record.id === sampleId) ?? null;

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/samples', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return (await sampleViews(app, req.params.id)).map((s) => s.view);
  });

  /** Upload one sample PDF (multipart: `role` field first, then the file). */
  app.post<{ Params: ProjectParams }>('/workbench/projects/:id/samples', async (req, reply) => {
    const projectId = req.params.id;
    if (!(await workbench.getProject(projectId))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'file part is required' });
    const role = SampleRoleSchema.safeParse(multipartField(file, 'role') ?? 'dev');
    if (!role.success) return reply.code(400).send({ error: 'role must be dev or holdout' });
    const body = await file.toBuffer(); // throws RequestFileTooLargeError (413) past the limit
    if (!isPdf(body)) return reply.code(415).send({ error: 'file is not a PDF' });

    const samples = await workbench.listSamples(projectId);
    if (samples.length >= MAX_SAMPLES) {
      return reply.code(409).send({ error: `a project holds at most ${MAX_SAMPLES} samples` });
    }
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (samples.some((s) => s.sha256 === sha256)) {
      return reply.code(409).send({ error: 'this PDF is already a sample of the project' });
    }

    const { draft, published } = await versionsOf(templates, projectId);
    const version = draft ?? published ?? 1;
    const documentId = randomUUID();
    const key = inboxKey(projectId, version, documentId);
    await app.deps.store.put(app.deps.buckets.inbox, key, body, 'application/pdf');
    const job = await app.deps.repo.createWorkbenchJob(
      {
        id: documentId,
        filename: file.filename,
        sha256,
        sizeBytes: body.length,
        specId: projectId,
        specVersion: version,
        bucket: app.deps.buckets.inbox,
        objectKey: key,
      },
      { projectId, task: 'prepare' },
    );
    try {
      const record = await workbench.addSample({
        projectId,
        documentId,
        role: role.data,
        addedForVersion: version,
      });
      return reply.code(201).send(await toView(app, record, job));
    } catch (err) {
      if (err instanceof WorkbenchConflictError)
        return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.patch<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid',
    async (req, reply) => {
      const params = SampleParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'sample not found' });
      const body = RoleBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const updated = await workbench.setSampleRole(
        params.data.id,
        params.data.sid,
        body.data.role,
      );
      if (!updated) return reply.code(404).send({ error: 'sample not found' });
      return (await findSample(params.data.id, params.data.sid))!.view;
    },
  );

  app.delete<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid',
    async (req, reply) => {
      const params = SampleParams.safeParse(req.params);
      const removed =
        params.success && (await workbench.removeSample(params.data.id, params.data.sid));
      return removed ? reply.code(204).send() : reply.code(404).send({ error: 'sample not found' });
    },
  );

  app.get<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid/text',
    async (req, reply) => {
      const params = SampleParams.safeParse(req.params);
      const sample = params.success ? await findSample(params.data.id, params.data.sid) : null;
      if (!sample) return reply.code(404).send({ error: 'sample not found' });
      if (sample.view.state !== 'ready') {
        return reply.code(409).send({ error: `sample is ${sample.view.state}, not ready` });
      }
      const text = await readJson(app, preparedTextKey(sample.record.sha256));
      if (text === null) return reply.code(409).send({ error: 'prepared text is missing' });
      return PreparedTextSchema.parse(text);
    },
  );
};
