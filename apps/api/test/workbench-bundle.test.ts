import { describe, expect, it } from 'vitest';
import {
  draftingKey,
  exportKey,
  preparedTriageKey,
  type ExportView,
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import { MemoryAccessRepo } from '../src/access/repo.js';
import type { AppDeps } from '../src/app.js';
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
