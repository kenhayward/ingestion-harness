import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BriefBodySchema,
  BUNDLE_EXPORTED_EVENT,
  BundleManifestSchema,
  EMPTY_BRIEF,
  ExportViewSchema,
  MAX_SAMPLES,
  ProjectViewSchema,
  STAGE_ORDER,
  SurveyBodySchema,
  draftingKey,
  exportKey,
  type BriefBody,
  type DraftResult,
  type DraftStage,
  type ExportView,
  type SurveyBody,
  type WorkbenchProject,
} from '@ih/shared';
import type { JobEventRecord, ProjectJob } from '../repositories/types.js';
import { startedChange } from '../templates/changes.js';
import { pinned } from '../templates/drafts.js';
import { retiredProblem, RETIRED_DOC } from '../templates/retirement.js';
import { TemplateConflictError } from '../templates/repo.js';
import {
  BUNDLE_TEXT_ALLOWANCE,
  BundleError,
  firstIssue,
  jsonEntry,
  readBundle,
  sampleFiles,
  templateEntry,
  type ReadBundle,
} from '../workbench/bundle-import.js';
import { WorkbenchConflictError } from '../workbench/repo.js';
import { binary, error, md, res } from '../openapi/zod.js';
import { multipartField } from '../uploads.js';
import {
  Id as ProjectId,
  acceptedSurvey,
  addSampleFile,
  isAdmin,
  projectView,
  sampleViews,
  stagesOf,
  versionsOf,
} from './workbench.js';
import { creatorOf } from '../access/routes.js';

/**
 * Drafting bundles (Workbench phase 6): a zip of the drafting context and the dev samples, built
 * by the worker's `export` task, so drafting can continue in another tool.
 */
const LOCAL_EXPORT = 'exporting a local-only project needs an admin';
const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const JobParams = z.object({ id: Id, jobId: z.string().uuid() });
/** The template version the export carried (`draft` is the definition it was built from). */
const ExportedVersion = z.object({ draft: z.object({ version: z.number().int() }) });
/** The samples the export carried. */
const ExportedSamples = z.object({ samples: z.array(z.object({ sampleId: z.string() })) });
const SAMPLES_CHANGED = 'a sample changed since this export; export again';

/** Route docs (docs/design/api-docs.md). */
const ProjectIdParams = z.object({ id: z.string().describe('The project id.') });
const PROJECT_NOT_FOUND = error('`project not found`.');
const LOCAL_ONLY = error(
  '`exporting a local-only project needs an admin`: the bundle carries the samples.',
);
const BUNDLE_DOCS =
  'https://github.com/kenhayward/ingestion-harness/blob/main/docs/design/workbench.md';

const MAX_BUNDLE_ENTRIES = MAX_SAMPLES + 32;
/** Bytes read from the saved zip per step. */
const READ_CHUNK = 64 * 1024;

/**
 * Saves the uploaded zip to `path`, refusing it past `limit` bytes (400). Busboy stops the file at
 * `limit` and ends the stream with `truncated` set: that check is the one that fires.
 * (@fastify/multipart throws its 413 RequestFileTooLargeError only from `toBuffer()`.)
 */
async function saveUpload(file: MultipartFile, path: string, limit: number) {
  let received = 0;
  // Defence in depth: unreachable while busboy enforces `limit`, kept in case it ever does not.
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      done(received > limit ? new BundleError('bundle is too large') : null, chunk);
    },
  });
  await pipeline(file.file, count, createWriteStream(path));
  if (file.file.truncated) throw new BundleError('bundle is too large');
}

/** A status and body, sent by the import route once its temp files are removed. */
interface Answer {
  code: number;
  body: unknown;
}
const answer = (code: number, body: unknown): Answer => ({ code, body });

/** What the export job's params say about the bundle (written by the export route). */
const ExportFacts = z.object({
  briefVersion: z.number().int().nullable().optional(),
  samples: z.array(z.unknown()).optional(),
});
const ExportedBytes = z.object({ bytes: z.number().int().nonnegative() });

const exportView = (
  j: ProjectJob,
  params: unknown,
  exported: JobEventRecord | undefined,
): ExportView => {
  const facts = ExportFacts.safeParse(params);
  const bytes = j.status === 'succeeded' ? ExportedBytes.safeParse(exported?.data) : null;
  return {
    jobId: j.id,
    status: j.status,
    error: j.error,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    briefVersion: facts.success ? (facts.data.briefVersion ?? null) : null,
    devSamples: facts.success && facts.data.samples ? facts.data.samples.length : null,
    bytes: bytes?.success ? bytes.data.bytes : null,
  };
};

/** The brief's ontology versions with their bytes' sha256 (a version not found is left out). */
async function briefOntologies(app: FastifyInstance, brief: BriefBody) {
  const out: { id: string; version: number; sha256: string }[] = [];
  for (const pick of brief.ontologies ?? []) {
    const detail = await app.deps.ontologies.get(pick.ontologyId);
    const version = detail?.versions.find((v) => v.version === pick.version);
    if (version?.sha256)
      out.push({ id: pick.ontologyId, version: pick.version, sha256: version.sha256 });
  }
  return out;
}

/**
 * The local version holding each of the bundle's ontologies' bytes (`id@bundleVersion` ->
 * local version; the bundle's own number first), and those the library lacks, as `id vN`.
 */
async function locateOntologies(
  app: FastifyInstance,
  wanted: { id: string; version: number; sha256: string }[],
) {
  const missing: string[] = [];
  const versions = new Map<string, number>();
  for (const o of wanted) {
    const detail = await app.deps.ontologies.get(o.id);
    const same = (detail?.versions ?? []).filter((v) => v.sha256 === o.sha256);
    const local = same.find((v) => v.version === o.version) ?? same[0];
    if (local) versions.set(`${o.id}@${o.version}`, local.version);
    else missing.push(`${o.id} v${o.version}`);
  }
  return { missing, versions };
}

export const workbenchBundleRoutes: FastifyPluginAsync = async (app) => {
  const { repo, store, buckets, templates, workbench } = app.deps;

  /**
   * The imported stage rail: the survey as an accepted proposal (a finished draft job that no
   * worker claims, holding the imported body), then a skip for every other completed stage.
   * Completions are written in `STAGE_ORDER` so none is stale. A completed survey without a
   * `survey.json` is skipped: the draft holds the work, but there is no survey to accept.
   */
  const restoreStages = async (
    projectId: string,
    input: { survey: SurveyBody | null; completed: DraftStage[]; briefVersion: number | null },
  ) => {
    if (input.survey) {
      const job = await repo.createFinishedDraftJob(projectId, {
        stage: 'survey',
        dataPolicy: 'local',
        imported: true,
      });
      const result: DraftResult = {
        stage: 'survey',
        model: 'imported',
        body: input.survey,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      await store.put(
        buckets.runs,
        draftingKey(projectId, job.id),
        Buffer.from(JSON.stringify(result)),
        'application/json',
      );
      await workbench.createProposal({
        id: job.id,
        projectId,
        stage: 'survey',
        briefVersion: input.briefVersion,
        baseVersion: null,
        baseDefinition: null,
        feedbackIds: null,
      });
      await workbench.decideProposal(projectId, job.id, 'accepted');
    }
    for (const stage of STAGE_ORDER) {
      if (!input.completed.includes(stage)) continue;
      if (stage === 'survey' && input.survey) continue; // accepted above
      await workbench.addSkip(projectId, stage);
    }
  };

  /** Saves the upload under `dir` and reads it; a refusal comes back as the BundleError. */
  const readUpload = async (
    file: MultipartFile,
    dir: string,
    limit: number,
  ): Promise<ReadBundle | BundleError> => {
    try {
      const zipPath = join(dir, 'bundle.zip');
      await saveUpload(file, zipPath, limit);
      return await readBundle(createReadStream(zipPath, { highWaterMark: READ_CHUNK }), {
        maxUploadBytes: app.deps.maxUploadBytes,
        maxInflated: limit,
        maxEntries: MAX_BUNDLE_ENTRIES,
        tmpRoot: dir,
      });
    } catch (err) {
      if (err instanceof BundleError) return err;
      throw err;
    }
  };

  /** Checks the read bundle, then writes the project; nothing is written before every check. */
  const createFromBundle = async (
    req: FastifyRequest,
    input: { bundle: ReadBundle; idField?: string; nameField?: string },
  ) => {
    const { bundle, idField, nameField } = input;
    const files = bundle.text;
    const manifest = jsonEntry(files, 'manifest.json', BundleManifestSchema);
    if (!manifest.ok) return answer(400, { error: manifest.error });
    const definition = templateEntry(files);
    if (!definition) {
      return answer(400, { error: 'template.yaml is not a recipe mapping' });
    }
    let brief: BriefBody | null = null; // a bundle without a brief saves none
    if (files.has('brief.json')) {
      const parsed = jsonEntry(files, 'brief.json', BriefBodySchema);
      if (!parsed.ok) return answer(400, { error: parsed.error });
      brief = parsed.value;
    }
    let survey: SurveyBody | null = null; // older bundles carry none
    if (files.has('survey.json')) {
      const parsed = jsonEntry(files, 'survey.json', SurveyBodySchema);
      if (!parsed.ok) return answer(400, { error: parsed.error });
      survey = parsed.value;
    }
    const id = ProjectId.safeParse(idField ?? manifest.value.project.id);
    if (!id.success) return answer(400, { error: `id: ${firstIssue(id.error)}` });
    const projectId = id.data;
    const name = nameField ?? manifest.value.project.name;
    const taken = { error: `${projectId} already exists here; import under another id` };
    if (
      (await workbench.getProject(projectId)) ||
      (await templates.list()).some((r) => r.id === projectId)
    ) {
      return answer(409, taken);
    }
    const retired = await retiredProblem(app.deps, projectId);
    if (retired) return answer(409, { error: retired });
    const samples = await sampleFiles(bundle, manifest.value, app.deps.maxUploadBytes);
    if (typeof samples === 'string') return answer(400, { error: samples });
    const located = await locateOntologies(app, manifest.value.ontologies ?? []);
    if (located.missing.length) {
      return answer(400, {
        error: `bundle needs ontologies not in the library: ${located.missing.join(', ')}`,
      });
    }
    // Version numbers differ between deployments: the brief points at the local version that
    // holds the same bytes.
    if (brief) {
      brief = {
        ...brief,
        ontologies: brief.ontologies.map((o) => ({
          ...o,
          version: located.versions.get(`${o.ontologyId}@${o.version}`) ?? o.version,
        })),
      };
    }

    // Only now write: the draft, the project, the brief, then the samples.
    try {
      await templates.create(
        projectId,
        1,
        pinned(definition, projectId, 1),
        'draft',
        startedChange('Imported from a bundle', req.auth?.label ?? null, 'import'),
      );
    } catch (err) {
      // Another import or project creation took the id after the check above.
      if (err instanceof TemplateConflictError) return answer(409, taken);
      throw err;
    }
    let project: WorkbenchProject;
    try {
      project = await workbench.createProject(projectId, name);
    } catch (err) {
      await templates.deleteDraft(projectId, 1); // leave no draft without its project
      if (err instanceof WorkbenchConflictError) return answer(409, taken);
      throw err;
    }
    // The project exists from here on: a failure names it so the user can delete it.
    const failed = (detail: Record<string, unknown>) => {
      req.log.error({ projectId, ...detail }, 'bundle import failed');
      return answer(500, {
        error: `import failed after creating project ${projectId}; delete the project and import again`,
      });
    };
    try {
      // A bundle exported without a saved brief carries the empty one: save none.
      const saved =
        brief && manifest.value.briefVersion !== null
          ? await workbench.saveBrief(projectId, brief)
          : null;
      for (const sample of samples) {
        const body = await readFile(sample.path); // one sample in memory at a time
        const added = await addSampleFile(app, project, {
          filename: sample.filename,
          body,
          role: 'dev',
          createdBy: creatorOf(req),
        });
        // Unexpected after validation.
        if ('error' in added) return failed({ filename: sample.filename, error: added.error });
      }
      await restoreStages(projectId, {
        survey,
        completed: manifest.value.completedStages ?? [],
        briefVersion: saved?.version ?? null,
      });
    } catch (err) {
      return failed({ err });
    }
    req.log.info({ projectId, samples: samples.length }, 'bundle imported');
    return answer(201, await projectView(app, project));
  };

  /**
   * Import a bundle as a new project (multipart: optional `id` and `name` fields, then the zip).
   * Everything is checked before anything is written.
   */
  app.post(
    '/workbench/projects/import',
    {
      schema: {
        tags: ['Bundles'],
        operationId: 'importBundle',
        summary: 'Import a bundle as a new project',
        consumes: ['multipart/form-data'],
        description: md`
          Creates a project from an exported bundle: a v1 draft of its transformation recipe, a \`local\`
          project, its brief, its accepted survey and completed stages, and its dev samples
          (prepared again). Send the optional \`id\` and \`name\` fields **before** the
          \`bundle\` file; blank means the bundle's own. Everything (manifest, recipe, brief,
          every sample file and its sha256: a PDF, or a Word document without tracked changes,
          as an upload) is checked before anything is written. The zip and what it
          inflates to are capped at 12 samples at the upload limit plus 8 MiB. See the
          [bundle layout](${BUNDLE_DOCS}).`,
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: "The new project's id. Default: the bundle's." },
            name: { type: 'string', description: "The new project's name. Default: the bundle's." },
            bundle: {
              type: 'string',
              format: 'binary',
              description: 'The bundle zip. Send it last.',
            },
          },
          required: ['bundle'],
        },
        response: {
          201: res('The new project.', ProjectViewSchema),
          400: error(
            '`bundle file part is required`, `bundle is too large`, or what is wrong with the ' +
              'bundle (manifest, recipe, brief, a sample, or the id).',
          ),
          406: error('The request is not `multipart/form-data`.'),
          409: error('The id is taken: import under another id; or ' + RETIRED_DOC + '.'),
          500: error(
            '`import failed after creating project {id}; delete the project and import again`.',
          ),
        },
      },
    },
    async (req, reply) => {
      // One limit for the zip and for what it inflates to: every PDF at the upload limit, plus text.
      const limit = app.deps.maxUploadBytes * MAX_SAMPLES + BUNDLE_TEXT_ALLOWANCE;
      const file = await req.file({ limits: { fileSize: limit } });
      if (!file) return reply.code(400).send({ error: 'bundle file part is required' });
      const idField = multipartField(file, 'id')?.trim() || undefined; // blank = absent
      const nameField = multipartField(file, 'name')?.trim() || undefined;
      const dir = await mkdtemp(join(tmpdir(), 'ih-import-'));
      let out: Answer;
      try {
        const bundle = await readUpload(file, dir, limit);
        out =
          bundle instanceof BundleError
            ? answer(400, { error: bundle.message })
            : await createFromBundle(req, { bundle, idField, nameField });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      // Answered only once the temp files are gone. (FastifyReply: the code is computed, not one
      // of the documented literals.)
      return (reply as FastifyReply).code(out.code).send(out.body);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/workbench/projects/:id/export',
    {
      schema: {
        tags: ['Bundles'],
        operationId: 'exportBundle',
        summary: 'Export the project as a bundle',
        description: md`
          Queues an export job that builds the project's bundle: a zip with a manifest, the
          brief, the draft recipe, the accepted survey and completed stages, the drafting
          context (the same text a drafting model sees) and the ready dev samples as uploaded
          (PDFs, or Word documents as \`.docx\`). Holdout
          samples never leave. A new export replaces the previous one. Poll
          \`GET …/exports\`, then download the zip. Exporting a \`local\` project needs the
          admin, since the bundle takes the samples out of the harness.
        `,
        params: ProjectIdParams,
        response: {
          202: res('The queued export.', ExportViewSchema),
          403: LOCAL_ONLY,
          404: PROJECT_NOT_FOUND,
          409: error('`the project has no recipe version`, or `no prepared dev samples`.'),
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const project = await workbench.getProject(id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      // The bundle carries sample PDFs and text out of the harness: like allowing external models.
      if (project.dataPolicy === 'local' && !isAdmin(app, req)) {
        return reply.code(403).send({ error: LOCAL_EXPORT });
      }
      const { draft, latest } = await versionsOf(templates, id);
      const record = draft !== null ? await templates.get(id, draft) : latest;
      if (!record) return reply.code(409).send({ error: 'the project has no recipe version' });
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
      const completedStages = (await stagesOf(app, id))
        .filter((s) => s.state === 'accepted' || s.state === 'skipped')
        .map((s) => s.stage);
      const params = {
        stage: 'export',
        dataPolicy: project.dataPolicy,
        projectName: project.name,
        briefVersion: brief?.version ?? null,
        brief: brief?.body ?? EMPTY_BRIEF,
        draft: record.definition,
        survey: await acceptedSurvey(app, id),
        completedStages,
        ontologies: await briefOntologies(app, brief?.body ?? EMPTY_BRIEF),
        samples,
      };
      const { job, removed } = await repo.createExportJob(id, params);
      for (const removedId of removed) await store.delete(buckets.runs, exportKey(id, removedId));
      req.log.info(
        { projectId: id, jobId: job.id, samples: samples.length },
        'bundle export queued',
      );
      return reply.code(202).send(exportView(job, params, undefined));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/workbench/projects/:id/exports',
    {
      schema: {
        tags: ['Bundles'],
        operationId: 'listExports',
        summary: "List a project's exports",
        description: md`
          The project's export jobs, newest first (at most one: a new export replaces the old).
          Download a \`succeeded\` one with \`GET …/exports/{jobId}/bundle\`. Each carries the
          brief version and the number of dev samples it was built from, and, once
          \`succeeded\`, the zip's size in \`bytes\`.
        `,
        params: ProjectIdParams,
        response: { 200: res('The exports.', z.array(ExportViewSchema)), 404: PROJECT_NOT_FOUND },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const jobs = await repo.listExportJobs(req.params.id);
      const events = await repo.latestEvents(
        jobs.map((j) => j.id),
        [BUNDLE_EXPORTED_EVENT],
      );
      return Promise.all(
        jobs.map(async (j) =>
          exportView(
            j,
            await repo.getJobParams(j.id),
            events.find((e) => e.jobId === j.id),
          ),
        ),
      );
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    '/workbench/projects/:id/exports/:jobId/bundle',
    {
      schema: {
        tags: ['Bundles'],
        operationId: 'downloadBundle',
        summary: 'Download an exported bundle',
        description: md`
          The bundle zip of a finished export. Refused when a sample the export carried has
          since been removed or made holdout (export again), and, for a \`local\` project,
          for anyone but an admin.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          jobId: z.string().uuid().describe('The export job id.'),
        }),
        response: {
          200: binary('The bundle zip.', 'application/zip'),
          403: LOCAL_ONLY,
          404: error('`project not found`, `export not found` or `bundle not found`.'),
          409: error(
            '`the export has not finished`, or `a sample changed since this export; export again`.',
          ),
        },
      },
    },
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
      const jobParams = await repo.getJobParams(jobId);
      // Holdout rule (ADR 0007): a sample made holdout or removed since must not leave in an
      // older bundle. Membership and role only; a sample added later is simply not in it.
      const carried = ExportedSamples.safeParse(jobParams);
      const devIds = new Set(
        (await workbench.listSamples(id)).filter((s) => s.role === 'dev').map((s) => s.id),
      );
      if (!carried.success || carried.data.samples.some((s) => !devIds.has(s.sampleId))) {
        return reply.code(409).send({ error: SAMPLES_CHANGED });
      }
      const body = await store.get(buckets.runs, exportKey(id, jobId));
      if (!body) return reply.code(404).send({ error: 'bundle not found' });
      const exported = ExportedVersion.safeParse(jobParams);
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
