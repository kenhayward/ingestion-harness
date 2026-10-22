import { describe, expect, it } from 'vitest';
import { preparedTextKey, preparedTriageKey, type SampleView } from '@ih/shared';
import {
  TEST_PASSWORD,
  accessApp,
  fakePdf,
  letter,
  multipart,
  signIn,
  signInNewUser,
  testApp,
} from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

/** Signed in as the admin from the log (name `Admin`) and a user named `user`. */
async function signedIn() {
  const ctx = await accessApp();
  const upload = (cookie: string, filename = 'a.pdf') => {
    const form = multipart({ specId: 'demo' }, { filename, content: fakePdf });
    return ctx.app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: form.payload,
      headers: { ...form.headers, cookie },
    });
  };
  const list = async (cookie: string, query = '') =>
    (await ctx.app.inject({ url: `/api/jobs${query}`, headers: { cookie } })).json() as {
      filename: string;
      createdBy: string | null;
    }[];
  return { ...ctx, upload, list };
}

const names = (jobs: { filename: string }[]) => jobs.map((j) => j.filename).sort();

describe('job creator', () => {
  it("records the signed-in user's name on an uploaded job", async () => {
    const { upload, adminCookie, userCookie } = await signedIn();
    expect((await upload(adminCookie)).json().createdBy).toBe('Admin');
    expect((await upload(userCookie)).json().createdBy).toBe('user');
  });

  it('lists only my jobs with ?mine=1, every job without it', async () => {
    const { upload, list, adminCookie, userCookie } = await signedIn();
    await upload(adminCookie, 'admin.pdf');
    await upload(userCookie, 'user-1.pdf');
    await upload(userCookie, 'user-2.pdf');
    expect(names(await list(userCookie))).toEqual(['admin.pdf', 'user-1.pdf', 'user-2.pdf']);
    expect(names(await list(userCookie, '?mine=1'))).toEqual(['user-1.pdf', 'user-2.pdf']);
    expect(names(await list(adminCookie, '?mine=1'))).toEqual(['admin.pdf']);
    expect(await list(adminCookie, '?mine=1&status=failed')).toEqual([]);
  });

  it('pages only my jobs with mine=1', async () => {
    const { app, upload, adminCookie, userCookie } = await signedIn();
    await upload(adminCookie, 'admin.pdf');
    await upload(userCookie, 'user-1.pdf');
    const page = async (cookie: string, q: string) =>
      (await app.inject({ url: `/api/jobs/page${q}`, headers: { cookie } })).json() as {
        jobs: { filename: string }[];
        counts: { all: number };
      };
    const mine = await page(userCookie, '?mine=1');
    expect(names(mine.jobs)).toEqual(['user-1.pdf']);
    expect(mine.counts.all).toBe(1);
    expect(names((await page(userCookie, '')).jobs)).toEqual(['admin.pdf', 'user-1.pdf']);
  });

  it("records the user's id beside the name", async () => {
    const { app, upload, userCookie } = await signedIn();
    const me = (await app.inject({ url: '/api/auth/me', headers: { cookie: userCookie } })).json();
    expect(me.userId).toMatch(/^[0-9a-f-]{36}$/);
    const job = (await upload(userCookie)).json();
    expect(job).toMatchObject({ createdBy: 'user', createdByUser: me.userId });
  });

  it('keeps my jobs mine after an admin renames me', async () => {
    const { app, access, upload, list, userCookie } = await signedIn();
    await upload(userCookie, 'before.pdf');
    const me = (await app.inject({ url: '/api/auth/me', headers: { cookie: userCookie } })).json();
    expect(await access.updateUser(me.userId, { name: 'Renamed' })).toMatchObject({
      name: 'Renamed',
    });
    await upload(userCookie, 'after.pdf');
    expect(names(await list(userCookie, '?mine=1'))).toEqual(['after.pdf', 'before.pdf']);
  });

  it('never gives a new user the jobs of someone who had their name', async () => {
    const { app, access, upload, list, userCookie } = await signedIn();
    await upload(userCookie, 'theirs.pdf');
    const me = (await app.inject({ url: '/api/auth/me', headers: { cookie: userCookie } })).json();
    await access.updateUser(me.userId, { name: 'Moved on' });
    const { cookie: newcomer } = await signInNewUser(
      app,
      access,
      'user',
      'designer',
      'new@example.test',
    );
    expect(await list(newcomer, '?mine=1')).toEqual([]);
  });

  it('matches older jobs without an id by name', async () => {
    const { repo, list, userCookie } = await signedIn();
    const old = await repo.createDocumentAndJob(
      {
        id: '99999999-9999-4999-8999-999999999999',
        filename: 'legacy.pdf',
        sha256: 'x'.repeat(64),
        sizeBytes: 10,
        specId: 'demo',
        specVersion: 1,
        bucket: 'ingest-inbox',
        objectKey: 'legacy.pdf',
      },
      null,
      false,
      null,
      null,
      { name: 'user', userId: null },
    );
    expect(old.createdByUser).toBeNull();
    expect(names(await list(userCookie, '?mine=1'))).toEqual(['legacy.pdf']);
  });

  it('applies the limit to my jobs, not to every job', async () => {
    const { upload, list, adminCookie, userCookie } = await signedIn();
    await upload(userCookie, 'mine.pdf');
    await upload(adminCookie, 'newer.pdf');
    expect(names(await list(userCookie, '?mine=1&limit=1'))).toEqual(['mine.pdf']);
  });

  it("matches by name, so the user's other sessions see the same list", async () => {
    const { app, upload, list, adminCookie, userCookie } = await signedIn();
    await upload(userCookie, 'before.pdf');
    await upload(adminCookie, 'not-mine.pdf');
    const cookie = await signIn(app, 'user@example.test', TEST_PASSWORD);
    expect(names(await list(cookie, '?mine=1'))).toEqual(['before.pdf']);
  });

  it('keeps the creator when someone else retries the job', async () => {
    const { app, repo, upload, adminCookie, userCookie } = await signedIn();
    const job = (await upload(userCookie)).json();
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'failed', attempts: 3 });
    const retried = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/retry`,
      headers: { cookie: adminCookie },
    });
    expect(retried.json()).toMatchObject({ status: 'queued', createdBy: 'user' });
  });

  it('records the creator of Workbench samples, test runs and regression runs', async () => {
    const { app, repo, store, templates, userCookie } = await signedIn();
    const cookie = userCookie;
    await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'letter', name: 'Letter' },
      headers: { cookie },
    });
    await templates.updateDraft('letter', 1, letter(1));
    const form = multipart({ role: 'dev' }, { filename: 's1.pdf', content: pdf(1) });
    const sample = (
      await app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        payload: form.payload,
        headers: { ...form.headers, cookie },
      })
    ).json() as SampleView;
    const prepare = repo.jobs.get(sample.prepareJobId!)!;
    expect(prepare.createdBy).toBe('user');

    repo.jobs.set(prepare.id, { ...prepare, status: 'succeeded' });
    const triage = { sha256: sample.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
    const text = { sha256: sample.sha256, pages: [{ number: 1, text: 'hello', ocr: false }] };
    const json = (value: unknown) => Buffer.from(JSON.stringify(value));
    await store.put('runs', preparedTriageKey(sample.sha256), json(triage), 'application/json');
    await store.put('runs', preparedTextKey(sample.sha256), json(text), 'application/json');
    const run = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/test-runs',
      payload: {},
      headers: { cookie },
    });
    expect(run.statusCode).toBe(201);
    expect(run.json().jobs.map((j: { createdBy: string }) => j.createdBy)).toEqual(['user']);

    await repo.createReference({
      templateId: 'letter',
      name: 's1.pdf',
      documentId: prepare.documentId,
      sourceJobId: prepare.id,
      expected: { fields: {}, tables: {} },
    });
    const regression = await app.inject({
      method: 'POST',
      url: '/api/templates/letter/versions/1/regression',
      headers: { cookie },
    });
    expect(regression.statusCode).toBe(201);
    expect(regression.json().jobs.map((j: { createdBy: string }) => j.createdBy)).toEqual(['user']);
  });
});

describe('job creator without access control', () => {
  it('records no creator, and has no jobs of mine', async () => {
    const { app } = await testApp();
    const upload = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo' }, { filename: 'a.pdf', content: fakePdf }),
    });
    expect(upload.json().createdBy).toBeNull();
    expect((await app.inject('/api/jobs')).json()).toHaveLength(1);
    expect((await app.inject('/api/jobs?mine=1')).json()).toEqual([]);
  });

  it('refuses a mine that is not a flag', async () => {
    const { app } = await testApp();
    expect((await app.inject('/api/jobs?mine=yes')).statusCode).toBe(400);
  });
});
