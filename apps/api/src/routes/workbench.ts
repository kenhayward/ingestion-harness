import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ProjectSummary, ProjectView, WorkbenchProject } from '@ih/shared';
import { createNextDraft, skeleton } from '../templates/drafts.js';
import type { TemplateRecord, TemplateRepo } from '../templates/repo.js';
import { WorkbenchConflictError } from '../workbench/repo.js';

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
};
