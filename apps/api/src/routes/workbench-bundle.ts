import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { Unzip, UnzipInflate, strFromU8 } from 'fflate';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  BriefBodySchema,
  BundleManifestSchema,
  EMPTY_BRIEF,
  MAX_SAMPLES,
  exportKey,
  type BriefBody,
  type BundleManifest,
  type ExportView,
  type WorkbenchProject,
} from '@ih/shared';
import type { ProjectJob } from '../repositories/types.js';
import { pinned } from '../templates/drafts.js';
import { TemplateConflictError } from '../templates/repo.js';
import { WorkbenchConflictError } from '../workbench/repo.js';
import { isPdf, multipartField } from '../uploads.js';
import {
  Id as ProjectId,
  acceptedSurvey,
  addSampleFile,
  isAdmin,
  projectView,
  sampleViews,
  versionsOf,
} from './workbench.js';

/**
 * Drafting bundles (Workbench phase 6): a zip of the drafting context and the dev samples, built
 * by the worker's `export` task, so drafting can continue in another tool.
 */
const LOCAL_EXPORT = 'exporting a local-only project needs the admin token';
const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const JobParams = z.object({ id: Id, jobId: z.string().uuid() });
/** The template version the export carried (`draft` is the definition it was built from). */
const ExportedVersion = z.object({ draft: z.object({ version: z.number().int() }) });
/** The samples the export carried. */
const ExportedSamples = z.object({ samples: z.array(z.object({ sampleId: z.string() })) });
const SAMPLES_CHANGED = 'a sample changed since this export; export again';

const MAX_BUNDLE_ENTRIES = MAX_SAMPLES + 32;
/** Room for the small text entries (manifest, brief, template, context) beside the PDFs. */
const BUNDLE_TEXT_ALLOWANCE = 8 * 1024 * 1024;
/** Compressed bytes inflated per step: bounds the work done between two size checks. */
const UNZIP_CHUNK = 16 * 1024;

/**
 * Unzips with limits against zip bombs: the entry count, and the bytes actually inflated across
 * all entries. The sizes the headers claim are never trusted; inflating stops as soon as the
 * running total passes `maxBytes`.
 */
export function unzipBundle(zip: Buffer, maxBytes: number): Record<string, Uint8Array> | string {
  const tooLarge = new RangeError('bundle is too large');
  const entries = new Map<string, Uint8Array[]>();
  const finished = new Set<string>();
  let total = 0;
  const unzip = new Unzip((file) => {
    if (entries.size >= MAX_BUNDLE_ENTRIES) throw tooLarge;
    if (entries.has(file.name)) throw new Error(`duplicate entry ${file.name}`);
    const chunks: Uint8Array[] = [];
    entries.set(file.name, chunks);
    file.ondata = (err, data, final) => {
      // UnzipInflate catches a throw from here and calls back with it as `err`: rethrow it.
      if (err) throw err;
      total += data.length;
      if (total > maxBytes) throw tooLarge;
      chunks.push(data);
      if (final) finished.add(file.name);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    const bytes = new Uint8Array(zip.buffer, zip.byteOffset, zip.length);
    for (let at = 0; at < bytes.length; at += UNZIP_CHUNK) {
      unzip.push(bytes.subarray(at, at + UNZIP_CHUNK), at + UNZIP_CHUNK >= bytes.length);
    }
  } catch (err) {
    return err === tooLarge ? 'bundle is too large' : 'not a valid bundle (zip)';
  }
  if (!entries.size || finished.size !== entries.size) return 'not a valid bundle (zip)';
  return Object.fromEntries([...entries].map(([name, chunks]) => [name, Buffer.concat(chunks)]));
}

const firstIssue = (err: z.ZodError) => {
  const issue = err.issues[0]!;
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
};

/** A JSON entry of the bundle checked against `schema`. */
function jsonEntry<S extends z.ZodTypeAny>(
  files: Record<string, Uint8Array>,
  name: string,
  schema: S,
): { ok: true; value: z.output<S> } | { ok: false; error: string } {
  const entry = files[name];
  if (!entry) return { ok: false, error: `${name}: missing from the bundle` };
  let value: unknown;
  try {
    value = JSON.parse(strFromU8(entry));
  } catch {
    return { ok: false, error: `${name}: not valid JSON` };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: `${name}: ${firstIssue(parsed.error)}` };
}

/** The template mapping in `template.yaml`, or null when it is not one. */
function templateEntry(files: Record<string, Uint8Array>): Record<string, unknown> | null {
  const entry = files['template.yaml'];
  if (!entry) return null;
  let value: unknown;
  try {
    value = parseYaml(strFromU8(entry));
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Each manifest sample's PDF, checked; a string is the first problem. */
function sampleFiles(
  files: Record<string, Uint8Array>,
  manifest: BundleManifest,
  maxUploadBytes: number,
): { filename: string; body: Buffer }[] | string {
  const seen = new Set<string>();
  const out: { filename: string; body: Buffer }[] = [];
  for (const s of manifest.samples) {
    const problem = (reason: string) => `sample ${s.filename}: ${reason}`;
    const entry = files[s.file];
    if (!entry) return problem(`${s.file} is missing from the bundle`);
    const body = Buffer.from(entry);
    if (!isPdf(body)) return problem('not a PDF');
    if (body.length > maxUploadBytes) return problem('larger than the upload limit');
    if (createHash('sha256').update(body).digest('hex') !== s.sha256) {
      return problem('the file does not match its sha256');
    }
    if (seen.has(s.sha256)) return problem('the same PDF as another sample');
    seen.add(s.sha256);
    out.push({ filename: s.filename, body });
  }
  return out;
}

const exportView = (j: ProjectJob): ExportView => ({
  jobId: j.id,
  status: j.status,
  error: j.error,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt,
});

export const workbenchBundleRoutes: FastifyPluginAsync = async (app) => {
  const { repo, store, buckets, templates, workbench } = app.deps;

  /**
   * Import a bundle as a new project (multipart: optional `id` and `name` fields, then the zip).
   * Everything is checked before anything is written.
   */
  app.post('/workbench/projects/import', async (req, reply) => {
    // One limit for the zip and for what it inflates to: every PDF at the upload limit, plus text.
    const limit = app.deps.maxUploadBytes * MAX_SAMPLES + BUNDLE_TEXT_ALLOWANCE;
    const file = await req.file({ limits: { fileSize: limit } });
    if (!file) return reply.code(400).send({ error: 'bundle file part is required' });
    const idField = multipartField(file, 'id')?.trim() || undefined; // blank = absent
    const nameField = multipartField(file, 'name')?.trim() || undefined;
    const zip = await file.toBuffer(); // throws RequestFileTooLargeError (413) past the limit

    const files = unzipBundle(zip, limit);
    if (typeof files === 'string') return reply.code(400).send({ error: files });
    const manifest = jsonEntry(files, 'manifest.json', BundleManifestSchema);
    if (!manifest.ok) return reply.code(400).send({ error: manifest.error });
    const definition = templateEntry(files);
    if (!definition) {
      return reply.code(400).send({ error: 'template.yaml is not a template mapping' });
    }
    let brief: BriefBody | null = null; // a bundle without a brief saves none
    if (files['brief.json']) {
      const parsed = jsonEntry(files, 'brief.json', BriefBodySchema);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      brief = parsed.value;
    }
    const id = ProjectId.safeParse(idField ?? manifest.value.project.id);
    if (!id.success) return reply.code(400).send({ error: `id: ${firstIssue(id.error)}` });
    const projectId = id.data;
    const name = nameField ?? manifest.value.project.name;
    const taken = { error: `${projectId} already exists here; import under another id` };
    if (
      (await workbench.getProject(projectId)) ||
      (await templates.list()).some((r) => r.id === projectId)
    ) {
      return reply.code(409).send(taken);
    }
    const samples = sampleFiles(files, manifest.value, app.deps.maxUploadBytes);
    if (typeof samples === 'string') return reply.code(400).send({ error: samples });

    // Only now write: the draft, the project, the brief, then the samples.
    let project: WorkbenchProject;
    try {
      await templates.create(projectId, 1, pinned(definition, projectId, 1), 'draft');
      project = await workbench.createProject(projectId, name);
    } catch (err) {
      // Another import or project creation took the id after the check above.
      if (err instanceof TemplateConflictError || err instanceof WorkbenchConflictError) {
        return reply.code(409).send(taken);
      }
      throw err;
    }
    if (brief) await workbench.saveBrief(projectId, brief);
    for (const sample of samples) {
      const added = await addSampleFile(app, project, { ...sample, role: 'dev' });
      if ('error' in added) {
        // Unexpected after validation; the created project is left for the user to inspect.
        req.log.error(
          { projectId, filename: sample.filename, error: added.error },
          'bundle import failed',
        );
        return reply.code(500).send({ error: `sample ${sample.filename}: ${added.error}` });
      }
    }
    req.log.info({ projectId, samples: samples.length }, 'bundle imported');
    return reply.code(201).send(await projectView(app, project));
  });

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
