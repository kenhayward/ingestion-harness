import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_BRIEF,
  draftingKey,
  exportKey,
  preparedTriageKey,
  type ExportView,
  type ProjectSummary,
  type ProjectView,
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import { MemoryAccessRepo } from '../src/access/repo.js';
import type { AppDeps } from '../src/app.js';
import { TemplateConflictError } from '../src/templates/repo.js';
import { WorkbenchConflictError } from '../src/workbench/repo.js';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);
const brief = {
  purpose: 'Letters to customers.',
  outputs: 'The sender.',
  exampleOutput: '',
  glossary: '',
  variants: '',
  rules: '',
  answers: [],
};
const LOCAL_EXPORT = 'exporting a local-only project needs the admin token';

async function project(overrides: Partial<AppDeps> = {}) {
  const ctx = await testApp(overrides);
  await ctx.workbench.createProject('letter', 'Letter');
  await ctx.templates.create('letter', 1, letter(1), 'draft');
  const add = async (n: number, role = 'dev', headers: Record<string, string> = {}) => {
    const body = multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) });
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        payload: body.payload,
        headers: { ...body.headers, ...headers },
      })
    ).json() as SampleView;
    const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
    ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
    const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
    await ctx.store.put(
      'runs',
      preparedTriageKey(s.sha256),
      Buffer.from(JSON.stringify(triage)),
      'application/json',
    );
    return s;
  };
  const start = (headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/export', headers });
  const list = async () =>
    (await ctx.app.inject('/api/workbench/projects/letter/exports')).json() as ExportView[];
  const download = (jobId: string, headers: Record<string, string> = {}) =>
    ctx.app.inject({
      url: `/api/workbench/projects/letter/exports/${jobId}/bundle`,
      headers,
    });
  const finish = (jobId: string) => {
    const job = ctx.repo.exportJobs.get(jobId)!;
    ctx.repo.exportJobs.set(jobId, { ...job, status: 'succeeded' });
  };
  return { ...ctx, add, start, list, download, finish };
}

describe('export', () => {
  it('queues an export with the dev samples only and the drafting context inputs', async () => {
    const { app, repo, workbench, add, start } = await project();
    const dev = await add(1);
    await add(2, 'holdout');
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/brief',
      payload: brief,
    });
    expect(saved.statusCode).toBe(201);

    const res = await start();
    expect(res.statusCode).toBe(202);
    const view = res.json() as ExportView;
    expect(view).toMatchObject({ status: 'queued', error: null });

    // Document-less: never a JobSummary, kept with the other export jobs.
    expect(repo.jobs.has(view.jobId)).toBe(false);
    const stored = repo.exportJobs.get(view.jobId)!;
    expect(stored.projectId).toBe('letter');
    const record = (await workbench.listSamples('letter')).find((s) => s.id === dev.id)!;
    expect(stored.params).toEqual({
      stage: 'export',
      dataPolicy: 'local',
      projectName: 'Letter',
      briefVersion: 1,
      brief,
      draft: letter(1),
      survey: null,
      samples: [
        {
          sampleId: dev.id,
          filename: 's1.pdf',
          sha256: dev.sha256,
          role: 'dev',
          bucket: 'inbox',
          objectKey: record.objectKey,
        },
      ],
    });
    expect(await repo.getJobParams(view.jobId)).toEqual(stored.params);
  });

  it('carries the accepted survey', async () => {
    const { app, repo, store, add, start } = await project();
    await add(1);
    const survey = {
      summary: 'Letters.',
      structure: [],
      variants: [],
      candidates: [],
      questions: [],
    };
    const proposal = (
      await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/survey' })
    ).json() as ProposalView;
    repo.draftJobs.set(proposal.id, { ...repo.draftJobs.get(proposal.id)!, status: 'succeeded' });
    await store.put(
      'runs',
      draftingKey('letter', proposal.id),
      Buffer.from(
        JSON.stringify({
          stage: 'survey',
          model: 'local/m',
          body: survey,
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ),
      'application/json',
    );
    const decided = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/proposals/${proposal.id}/decision`,
      payload: { decision: 'accepted' },
    });
    expect(decided.statusCode).toBe(200);

    const view = (await start()).json() as ExportView;
    expect(repo.exportJobs.get(view.jobId)!.params.survey).toEqual(survey);
  });

  it('replaces the previous export and deletes its zip', async () => {
    const { repo, store, add, start, finish } = await project();
    await add(1);
    const first = (await start()).json() as ExportView;
    finish(first.jobId);
    await store.put(
      'runs',
      exportKey('letter', first.jobId),
      Buffer.from('zip'),
      'application/zip',
    );

    const second = await start();
    expect(second.statusCode).toBe(202);
    const secondId = (second.json() as ExportView).jobId;
    expect((await repo.listExportJobs('letter')).map((j) => j.id)).toEqual([secondId]);
    expect(await store.get('runs', exportKey('letter', first.jobId))).toBeNull();
  });

  it('refuses with no prepared dev samples', async () => {
    const { repo, add, start } = await project();
    await add(1, 'holdout');
    const res = await start();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no prepared dev samples');
    expect(repo.exportJobs.size).toBe(0);
  });

  it('refuses a project without a template version, and an unknown project', async () => {
    const { app, workbench } = await project();
    await workbench.createProject('memo', 'Memo');
    const none = await app.inject({ method: 'POST', url: '/api/workbench/projects/memo/export' });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe('the project has no template version');
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/nope/export',
    });
    expect(unknown.statusCode).toBe(404);
    expect((await app.inject('/api/workbench/projects/nope/exports')).statusCode).toBe(404);
  });

  it('lists exports newest first', async () => {
    const { repo, add, start, list, finish } = await project();
    await add(1);
    expect(await list()).toEqual([]);
    const view = (await start()).json() as ExportView;
    expect(await list()).toEqual([view]);
    finish(view.jobId);
    const [listed] = await list();
    expect(listed).toMatchObject({ jobId: view.jobId, status: 'succeeded' });
    // Another project's exports are not listed.
    await repo.createExportJob('other', { stage: 'export' });
    expect((await list()).map((e) => e.jobId)).toEqual([view.jobId]);
  });

  it('downloads a finished bundle and refuses an unfinished one', async () => {
    const { app, store, add, start, download, finish } = await project();
    await add(1);
    const view = (await start()).json() as ExportView;

    const queued = await download(view.jobId);
    expect(queued.statusCode).toBe(409);
    expect(queued.json().error).toBe('the export has not finished');

    finish(view.jobId);
    const missing = await download(view.jobId);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('bundle not found');

    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x10]);
    await store.put('runs', exportKey('letter', view.jobId), bytes, 'application/zip');
    const res = await download(view.jobId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="letter-v1-bundle.zip"');
    expect(res.rawPayload.equals(bytes)).toBe(true);

    expect((await download('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    const proposal = (
      await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/survey' })
    ).json() as ProposalView;
    expect((await download(proposal.id)).statusCode).toBe(404);
    expect((await download('not-a-uuid')).statusCode).toBe(404);
  });

  it('revoking to local downgrades a queued export, like every other project job', async () => {
    const { repo, workbench, add, start } = await project();
    await workbench.setDataPolicy('letter', 'external', null);
    await add(1);
    const view = (await start()).json() as ExportView;
    expect(repo.exportJobs.get(view.jobId)!.params.dataPolicy).toBe('external');
    await workbench.setDataPolicy('letter', 'local', null);
    expect(repo.exportJobs.get(view.jobId)!.params).toMatchObject({
      stage: 'export',
      dataPolicy: 'local',
    });
  });

  it('does not download an export of another project', async () => {
    const { app, repo, store, workbench, add, start, finish } = await project();
    await add(1);
    await workbench.createProject('memo', 'Memo');
    const view = (await start()).json() as ExportView;
    finish(view.jobId);
    await store.put('runs', exportKey('letter', view.jobId), Buffer.from('zip'), 'application/zip');
    const res = await app.inject(`/api/workbench/projects/memo/exports/${view.jobId}/bundle`);
    expect(res.statusCode).toBe(404);
    expect(repo.exportJobs.has(view.jobId)).toBe(true);
  });
});

describe('export of a local-only project', () => {
  it('needs the admin token to export or download', async () => {
    const access = new MemoryAccessRepo();
    const ctx = await project({ access });
    const login = async (token: string) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { token },
      });
      return {
        cookie: `ih_session=${/ih_session=([^;]*)/.exec(String(res.headers['set-cookie']))![1]}`,
      };
    };
    const admin = await login(await access.rotateAdminToken());
    const user = await login((await access.createToken('user', null)).token);
    await ctx.add(1, 'dev', admin);

    const refused = await ctx.start(user);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe(LOCAL_EXPORT);
    expect(ctx.repo.exportJobs.size).toBe(0);

    const allowed = await ctx.start(admin);
    expect(allowed.statusCode).toBe(202);
    const view = allowed.json() as ExportView;
    ctx.finish(view.jobId);
    await ctx.store.put(
      'runs',
      exportKey('letter', view.jobId),
      Buffer.from('zip'),
      'application/zip',
    );
    const blocked = await ctx.download(view.jobId, user);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe(LOCAL_EXPORT);
    expect((await ctx.download(view.jobId, admin)).statusCode).toBe(200);

    const policy = await ctx.app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/data-policy',
      payload: { dataPolicy: 'external' },
      headers: admin,
    });
    expect(policy.statusCode).toBe(200);
    expect((await ctx.start(user)).statusCode).toBe(202);
  });
});

const pdfBytes = (n: number) => Buffer.from(`%PDF-1.7\n% bundle ${n}\n%%EOF\n`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const memoYaml = 'id: memo\nversion: 3\nname: Memo\noutputs:\n  fields: []\n  tables: []\n';
const samplePath = `samples/${sha(pdfBytes(1))}.pdf`;

/** A bundle's entries; `samples` are listed as m1.pdf, m2.pdf, … (default: one PDF). */
function bundleFiles(
  overrides: { manifest?: object; files?: Record<string, Uint8Array>; samples?: Buffer[] } = {},
) {
  const samples = overrides.samples ?? [pdfBytes(1)];
  const manifest = {
    format: 'ih-workbench-bundle',
    formatVersion: 1,
    project: { id: 'memo', name: 'Memo' },
    templateVersion: 3,
    briefVersion: 2,
    samples: samples.map((pdf, i) => ({
      sampleId: `x${i}`,
      filename: `m${i + 1}.pdf`,
      sha256: sha(pdf),
      file: `samples/${sha(pdf)}.pdf`,
      inContext: true,
    })),
    stages: ['survey'],
    ...overrides.manifest,
  };
  return {
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'brief.json': strToU8(JSON.stringify({ purpose: 'Memos' })),
    'template.yaml': strToU8(memoYaml),
    ...Object.fromEntries(samples.map((pdf) => [`samples/${sha(pdf)}.pdf`, new Uint8Array(pdf)])),
    ...overrides.files,
  } as Record<string, Uint8Array>;
}

/** 9 MiB of zeros: past the inflated limit for `maxUploadBytes: 1024`, a few KiB zipped. */
const PADDING = { 'padding.bin': new Uint8Array(9 * 1024 * 1024) };

/** Rewrites the uncompressed size `name` claims in its local and central headers. */
function lieAboutSize(zip: Buffer, name: string, size: number) {
  const out = Buffer.from(zip);
  const needle = Buffer.from(name);
  let patched = 0;
  for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, at + 1)) {
    if (at >= 30 && out.readUInt32LE(at - 30) === 0x04034b50) {
      out.writeUInt32LE(size, at - 30 + 22);
      patched += 1;
    } else if (at >= 46 && out.readUInt32LE(at - 46) === 0x02014b50) {
      out.writeUInt32LE(size, at - 46 + 24);
      patched += 1;
    }
  }
  expect(patched).toBe(2);
  return out;
}

const bundle = (overrides: Parameters<typeof bundleFiles>[0] = {}) =>
  Buffer.from(zipSync(bundleFiles(overrides)));

/** A bundle with one entry left out. */
function bundleWithout(name: string) {
  const files = bundleFiles();
  delete files[name];
  return Buffer.from(zipSync(files));
}

const importBundle = (app: FastifyInstance, zip: Buffer, fields: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/workbench/projects/import',
    ...multipart(fields, { filename: 'b.zip', content: zip, contentType: 'application/zip' }),
  });

describe('import', () => {
  it('imports a bundle as a new project with a v1 draft, the brief and dev samples', async () => {
    const { app, repo, store, templates } = await testApp();
    const res = await importBundle(app, bundle());
    expect(res.statusCode).toBe(201);
    const view = res.json() as ProjectView;
    expect(view.project).toMatchObject({ id: 'memo', name: 'Memo', dataPolicy: 'local' });
    expect(view.draft).toBe(1);
    expect(view.brief?.body).toEqual({ ...EMPTY_BRIEF, purpose: 'Memos' });

    const record = await templates.get('memo', 1);
    expect(record?.status).toBe('draft');
    expect(record?.definition).toEqual({
      id: 'memo',
      version: 1,
      name: 'Memo',
      outputs: { fields: [], tables: [] },
    });

    const samples = (
      await app.inject('/api/workbench/projects/memo/samples')
    ).json() as SampleView[];
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ filename: 'm1.pdf', role: 'dev', state: 'preparing' });
    const job = repo.jobs.get(samples[0]!.prepareJobId!)!;
    expect(job).toMatchObject({ task: 'prepare', status: 'queued' });
    const doc = repo.documents.get(samples[0]!.documentId)!;
    expect(await store.get(doc.bucket, doc.objectKey)).toEqual(pdfBytes(1));
  });

  it('takes the id and name fields over the manifest', async () => {
    const { app, templates } = await testApp();
    const res = await importBundle(app, bundle(), { id: 'memo2', name: 'Memo copy' });
    expect(res.statusCode).toBe(201);
    expect((res.json() as ProjectView).project).toMatchObject({ id: 'memo2', name: 'Memo copy' });
    expect((await templates.get('memo2', 1))?.definition).toMatchObject({
      id: 'memo2',
      version: 1,
    });
    expect(await templates.get('memo', 1)).toBeNull();
  });

  it.each(['project', 'document type'])(
    'refuses an id that is already a %s here, writing nothing',
    async (kind) => {
      const { app, repo, store, templates, workbench } = await testApp();
      if (kind === 'project') await workbench.createProject('memo', 'Memo');
      else await templates.create('memo', 1, { id: 'memo', version: 1, name: 'Memo' }, 'draft');
      const counts = async () => ({
        templates: (await templates.list()).length,
        projects: (await workbench.listProjects()).length,
        objects: store.objects.size,
        jobs: repo.jobs.size,
      });
      const before = await counts();
      const res = await importBundle(app, bundle());
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('memo already exists here; import under another id');
      expect(await counts()).toEqual(before);
    },
  );

  const otherPdf = new Uint8Array(Buffer.from('%PDF-1.7\n% not the listed bytes\n%%EOF\n'));
  const bigPdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 0x20)]);
  const manyEntries = Object.fromEntries(
    Array.from({ length: 45 }, (_, i) => [`extra/${i}.txt`, strToU8('x')]),
  );
  it.each<[string, () => Buffer, Record<string, string>, RegExp, number?]>([
    ['not a zip', () => Buffer.from('nope'), {}, /^not a valid bundle \(zip\)$/],
    ['formatVersion 2', () => bundle({ manifest: { formatVersion: 2 } }), {}, /^manifest\.json: /],
    ['no manifest.json', () => bundleWithout('manifest.json'), {}, /^manifest\.json: /],
    [
      'a PDF that does not match its sha256',
      () => bundle({ files: { [samplePath]: otherPdf } }),
      {},
      /^sample m1\.pdf: /,
    ],
    [
      'a listed sample missing from the zip',
      () => bundleWithout(samplePath),
      {},
      /^sample m1\.pdf: /,
    ],
    [
      'template.yaml that is not a mapping',
      () => bundle({ files: { 'template.yaml': strToU8('- a\n- b\n') } }),
      {},
      /^template\.yaml is not a template mapping$/,
    ],
    ['an invalid id field', () => bundle(), { id: 'Bad Id' }, /^id: /],
    [
      'an invalid brief.json',
      () => bundle({ files: { 'brief.json': strToU8('{"purpose": 3}') } }),
      {},
      /^brief\.json: /,
    ],
    [
      'a sample that is not a PDF',
      () => bundle({ samples: [Buffer.from('not a pdf')] }),
      {},
      /^sample m1\.pdf: not a PDF$/,
    ],
    [
      'a sample over the per-file upload limit',
      () => bundle({ samples: [bigPdf] }),
      {},
      /^sample m1\.pdf: larger than the upload limit$/,
      1024,
    ],
    [
      'the same PDF listed twice',
      () => bundle({ samples: [pdfBytes(1), pdfBytes(1)] }),
      {},
      /^sample m2\.pdf: /,
    ],
    ['too many entries', () => bundle({ files: manyEntries }), {}, /^bundle is too large$/],
    [
      'more inflated bytes than the limit',
      () => bundle({ files: PADDING }),
      {},
      /^bundle is too large$/,
      1024,
    ],
    [
      'headers that understate the inflated size',
      () => lieAboutSize(bundle({ files: PADDING }), 'padding.bin', 10),
      {},
      /^bundle is too large$/,
      1024,
    ],
  ])('rejects %s with 400 and writes nothing', async (_label, zip, fields, error, maxUpload) => {
    const { app, repo, store, templates } = await testApp(
      maxUpload ? { maxUploadBytes: maxUpload } : {},
    );
    const res = await importBundle(app, zip(), fields);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(error);
    const projects = (await app.inject('/api/workbench/projects')).json() as ProjectSummary[];
    expect(projects.map((p) => p.id)).not.toContain('memo');
    expect((await templates.list()).map((t) => t.id)).not.toContain('memo');
    expect(store.objects.size).toBe(0);
    expect(repo.jobs.size).toBe(0);
  });

  it('keeps a padded bundle small enough to upload', () => {
    // The guard is on inflated bytes: the zipped padding is far below the upload limit.
    expect(bundle({ files: PADDING }).length).toBeLessThan(1024 * 12);
  });

  it('takes a blank id field as absent', async () => {
    const { app } = await testApp();
    const res = await importBundle(app, bundle(), { id: '  ', name: '' });
    expect(res.statusCode).toBe(201);
    expect((res.json() as ProjectView).project).toMatchObject({ id: 'memo', name: 'Memo' });
  });

  it.each(['template', 'project'])(
    'answers 409 when the %s is created concurrently',
    async (kind) => {
      const { app, templates, workbench } = await testApp();
      if (kind === 'template') {
        vi.spyOn(templates, 'create').mockRejectedValueOnce(new TemplateConflictError('taken'));
      } else {
        vi.spyOn(workbench, 'createProject').mockRejectedValueOnce(
          new WorkbenchConflictError('taken'),
        );
      }
      const res = await importBundle(app, bundle());
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('memo already exists here; import under another id');
    },
  );
});
