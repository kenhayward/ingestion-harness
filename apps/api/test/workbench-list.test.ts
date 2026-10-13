import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectListItemSchema,
  stableJson,
  type ProjectListPage,
  type ProjectSummary,
  type SampleView,
} from '@ih/shared';
import { LIST_CACHE_VERSION, refreshListCache } from '../src/workbench/list.js';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

/**
 * Three projects: `alpha` with a dev sample and a brief, `beta` fully published (no open
 * draft), `gamma` allowed external models.
 */
async function setup() {
  const ctx = await testApp();
  const create = (id: string, name: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects', payload: { id, name } });
  for (const [id, name] of [
    ['alpha', 'Alpha letters'],
    ['beta', 'Beta invoices'],
    ['gamma', 'Gamma memos'],
  ] as const) {
    expect((await create(id, name)).statusCode).toBe(201);
  }
  await ctx.templates.updateDraft('alpha', 1, letter(1));
  const addSample = async (project: string, n: number) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/workbench/projects/${project}/samples`,
      ...multipart({ role: 'dev' }, { filename: `s${n}.pdf`, content: pdf(n) }),
    });
    expect(res.statusCode).toBe(201);
    return res.json<SampleView>();
  };
  await addSample('alpha', 1);
  const brief = await ctx.app.inject({
    method: 'PUT',
    url: '/api/workbench/projects/alpha/brief',
    payload: { purpose: 'Letters to customers' },
  });
  expect(brief.statusCode).toBe(201);
  await ctx.templates.updateDraft('beta', 1, { ...letter(1), name: 'Beta invoices' });
  await ctx.templates.publish('beta', 1);
  await ctx.workbench.setDataPolicy('gamma', 'external', 'admin');
  const list = async (query = '') => {
    const res = await ctx.app.inject(`/api/workbench/projects${query}`);
    expect(res.statusCode).toBe(200);
    return res.json<ProjectListPage>();
  };
  return { ...ctx, list, addSample };
}

const ids = (page: ProjectListPage) => page.items.map((i) => i.id);

describe('GET /api/workbench/projects (paged list)', () => {
  it('lists every project with facets, sorted by last activity', async () => {
    const { list } = await setup();
    const page = await list();
    expect(page.total).toBe(3);
    expect(page.facets).toMatchObject({ all: 3, published: 1, progress: 2 });
    for (const item of page.items) expect(ProjectListItemSchema.safeParse(item).success).toBe(true);
    const activity = page.items.map((i) => i.lastActivityAt);
    expect(activity).toEqual([...activity].sort().reverse());
    const alpha = page.items.find((i) => i.id === 'alpha')!;
    expect(alpha).toMatchObject({ samples: 1, devSamples: 1, holdoutSamples: 0, draft: 1 });
    expect(alpha.stages.find((s) => s.stage === 'brief')?.state).toBe('accepted');
    expect(page.items.find((i) => i.id === 'beta')).toMatchObject({
      draft: null,
      published: 1,
      phase: 'published',
      holdoutScore: null,
    });
  });

  it('searches, filters, sorts and pages', async () => {
    const { list } = await setup();
    expect(ids(await list('?q=MEMO'))).toEqual(['gamma']);
    expect(ids(await list('?q=alp'))).toEqual(['alpha']);
    expect(ids(await list('?policy=external'))).toEqual(['gamma']);
    const published = await list('?filter=published');
    expect(ids(published)).toEqual(['beta']);
    expect(published.facets.all).toBe(3);
    expect(ids(await list('?sort=name'))).toEqual(['alpha', 'beta', 'gamma']);
    expect(ids(await list('?sort=name&ids=gamma,alpha'))).toEqual(['alpha', 'gamma']);
    const past = await list('?size=25&page=2');
    expect(past.items).toEqual([]);
    expect(past.total).toBe(3);
  });

  it.each([['?size=30'], ['?page=0'], ['?sort=x'], [`?q=${'a'.repeat(101)}`], ['?bogus=1']])(
    'refuses %s with Zod issues',
    async (query) => {
      const { app } = await setup();
      const res = await app.inject(`/api/workbench/projects${query}`);
      expect(res.statusCode).toBe(400);
      expect(Array.isArray(res.json().error)).toBe(true);
    },
  );

  it('keeps the unpaged list behind ?all=1', async () => {
    const { app } = await setup();
    const res = await app.inject('/api/workbench/projects?all=1');
    expect(res.statusCode).toBe(200);
    const projects = res.json<ProjectSummary[]>();
    expect(projects.map((p) => [p.id, p.draft, p.published, p.samples])).toEqual([
      ['alpha', 1, null, 1],
      ['beta', null, 1, 0],
      ['gamma', 1, null, 0],
    ]);
    expect(Object.keys(projects[0]!).sort()).toEqual(
      [
        'id',
        'name',
        'createdAt',
        'dataPolicy',
        'dataPolicyChangedAt',
        'dataPolicyChangedBy',
        'publishThreshold',
        'thresholdSetBy',
        'thresholdSetAt',
        'draft',
        'published',
        'samples',
      ].sort(),
    );
  });

  it('recomputes only the rows whose fingerprint changed', async () => {
    const { list, workbench, addSample } = await setup();
    await list();
    const spy = vi.spyOn(workbench, 'listProposals');
    await list();
    expect(spy).not.toHaveBeenCalled();
    await addSample('gamma', 2);
    const page = await list();
    expect(spy).toHaveBeenCalled();
    expect(new Set(spy.mock.calls.map(([id]) => id))).toEqual(new Set(['gamma']));
    expect(page.items.find((i) => i.id === 'gamma')).toMatchObject({ samples: 1, devSamples: 1 });
    spy.mockClear();
    await list();
    expect(spy).not.toHaveBeenCalled();
  });

  it('recomputes a cached row that no longer parses', async () => {
    const { list, workbench } = await setup();
    await list();
    const cached = workbench.listCacheRows.get('alpha')!;
    workbench.listCacheRows.set('alpha', { ...cached, item: { id: 'alpha' } });
    const page = await list();
    expect(page.items.find((i) => i.id === 'alpha')).toMatchObject({ devSamples: 1 });
    expect(
      ProjectListItemSchema.safeParse(workbench.listCacheRows.get('alpha')!.item).success,
    ).toBe(true);
  });

  it('stores rows under the code version and recomputes rows of another version', async () => {
    const { list, workbench } = await setup();
    const fingerprints = new Map(
      (await workbench.projectFingerprints()).map((f) => [f.id, f.fingerprint]),
    );
    await list();
    const cached = workbench.listCacheRows.get('alpha')!;
    expect(cached.fingerprint).toBe(`${LIST_CACHE_VERSION}:${fingerprints.get('alpha')}`);
    workbench.listCacheRows.set('alpha', {
      fingerprint: `${LIST_CACHE_VERSION + 1}:${fingerprints.get('alpha')}`,
      item: cached.item,
    });
    const spy = vi.spyOn(workbench, 'listProposals');
    await list();
    expect(new Set(spy.mock.calls.map(([id]) => id))).toEqual(new Set(['alpha']));
    expect(workbench.listCacheRows.get('alpha')!.fingerprint).toBe(cached.fingerprint);
  });

  it('stores a row under the fingerprint read before computing it', async () => {
    const { list, workbench, addSample } = await setup();
    const before = (await workbench.projectFingerprints()).find((f) => f.id === 'gamma')!;
    // A sample lands while gamma's row is being computed.
    const real = workbench.listProposals.bind(workbench);
    let added = false;
    vi.spyOn(workbench, 'listProposals').mockImplementation(async (id) => {
      if (id === 'gamma' && !added) {
        added = true;
        await addSample('gamma', 3);
      }
      return real(id);
    });
    await list();
    expect(workbench.listCacheRows.get('gamma')!.fingerprint).toBe(
      `${LIST_CACHE_VERSION}:${before.fingerprint}`,
    );
    // So the next request sees the change.
    expect((await list()).items.find((i) => i.id === 'gamma')).toMatchObject({ devSamples: 1 });
  });

  it('takes the last activity from the fingerprint, never from the cached row', async () => {
    const { list, workbench } = await setup();
    await list();
    const cached = workbench.listCacheRows.get('alpha')!;
    workbench.listCacheRows.set('alpha', {
      ...cached,
      item: { ...(cached.item as object), lastActivityAt: '1999-01-01T00:00:00.000Z' },
    });
    const fresh = (await workbench.projectFingerprints()).find((f) => f.id === 'alpha')!;
    const spy = vi.spyOn(workbench, 'listProposals');
    const page = await list();
    expect(spy).not.toHaveBeenCalled();
    expect(page.items.find((i) => i.id === 'alpha')!.lastActivityAt).toBe(fresh.lastActivityAt);
  });

  it('answers from a degraded read but does not cache it', async () => {
    const { list, workbench, repo, store } = await setup();
    const job = await repo.createDraftJob('alpha', {});
    repo.draftJobs.set(job.id, { ...repo.draftJobs.get(job.id)!, status: 'succeeded' });
    await workbench.createProposal({
      id: job.id,
      projectId: 'alpha',
      stage: 'sections',
      briefVersion: null,
    });
    const get = store.get.bind(store);
    const outage = vi
      .spyOn(store, 'get')
      .mockImplementation(async (bucket, key) =>
        key.startsWith('drafting/') ? Promise.reject(new Error('store down')) : get(bucket, key),
      );
    expect((await list()).items.map((i) => i.id)).toContain('alpha');
    expect(workbench.listCacheRows.has('alpha')).toBe(false);
    expect(workbench.listCacheRows.has('beta')).toBe(true);
    const spy = vi.spyOn(workbench, 'listProposals');
    await list();
    expect(spy.mock.calls.map(([id]) => id)).toContain('alpha');
    // A missing body is not an outage: once the store answers, the row is cached.
    outage.mockRestore();
    await list();
    expect(workbench.listCacheRows.has('alpha')).toBe(true);
  });

  it('answers two cold requests at once and caches one row per project', async () => {
    const { app, workbench } = await setup();
    const [a, b] = await Promise.all([
      app.inject('/api/workbench/projects'),
      app.inject('/api/workbench/projects'),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json<ProjectListPage>().total).toBe(3);
    expect(b.json<ProjectListPage>().total).toBe(3);
    expect([...(await workbench.listCache()).keys()].sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('skips a project deleted after its fingerprint was read', async () => {
    const { list, workbench } = await setup();
    const real = workbench.projectFingerprints.bind(workbench);
    vi.spyOn(workbench, 'projectFingerprints').mockImplementation(async () => [
      ...(await real()),
      { id: 'ghost', fingerprint: 'f', lastActivityAt: '2026-10-13T00:00:00.000Z' },
    ]);
    const page = await list();
    expect(page.total).toBe(3);
    expect(ids(page)).not.toContain('ghost');
    expect((await workbench.listCache()).has('ghost')).toBe(false);
  });

  it('skips a project deleted while its row is computed', async () => {
    const { list, workbench } = await setup();
    const real = workbench.listProposals.bind(workbench);
    vi.spyOn(workbench, 'listProposals').mockImplementation(async (id) => {
      if (id === 'gamma' && (await workbench.getProject('gamma')))
        await workbench.deleteProject('gamma');
      return real(id);
    });
    const page = await list();
    expect(ids(page).sort()).toEqual(['alpha', 'beta']);
    expect(page.total).toBe(2);
    expect((await workbench.listCache()).has('gamma')).toBe(false);
  });

  it('skips a project whose draft row vanishes mid-computation instead of failing', async () => {
    // versionsOf has seen gamma's draft; the row is gone by the time it is read.
    const { list, workbench, templates } = await setup();
    const get = templates.get.bind(templates);
    vi.spyOn(templates, 'get').mockImplementation(async (id, version) => {
      if (id === 'gamma' && (await workbench.getProject('gamma'))) {
        await workbench.deleteProject('gamma');
        return null;
      }
      return get(id, version);
    });
    const page = await list();
    expect(ids(page).sort()).toEqual(['alpha', 'beta']);
  });

  it('still fails when computing a row of a project that exists fails', async () => {
    // Called directly: the route would answer an undocumented 500.
    const { app, templates } = await setup();
    const get = templates.get.bind(templates);
    vi.spyOn(templates, 'get').mockImplementation(async (id, version) =>
      id === 'gamma' ? null : get(id, version),
    );
    await expect(refreshListCache(app)).rejects.toThrow();
  });

  it("shows the gate's holdout score for an open draft", async () => {
    const { list, workbench, templates } = await setup();
    const iteration = await workbench.createIteration({
      projectId: 'gamma',
      templateVersion: 1,
      definition: (await templates.get('gamma', 1))!.definition,
      briefVersion: null,
      set: 'holdout',
      model: null,
      jobIds: [],
    });
    // The gate's cache for an iteration without jobs (gateFingerprint of no jobs).
    const fingerprint = createHash('sha256').update(stableJson([])).digest('hex');
    await workbench.setGateCache(iteration.id, { fingerprint, score: 0.8, completed: 0, total: 0 });
    const gamma = (await list()).items.find((i) => i.id === 'gamma')!;
    expect(gamma).toMatchObject({ draft: 1, holdoutScore: 0.8 });
    expect(gamma.flags.ready).toBe(false); // 0.8 is below the 0.9 threshold
  });

  it("shows a published type's newest own-model holdout score of the live version", async () => {
    const { list, workbench, templates } = await setup();
    const definition = (await templates.get('beta', 1))!.definition;
    const iteration = async (
      score: number | null,
      over: { model?: string | null; set?: 'dev' | 'holdout'; version?: number } = {},
    ) => {
      const i = await workbench.createIteration({
        projectId: 'beta',
        templateVersion: over.version ?? 1,
        definition,
        briefVersion: null,
        set: over.set ?? 'holdout',
        model: (over.model ?? null) as null,
        jobIds: [],
      });
      if (score !== null)
        await workbench.setIterationScores(i.id, { score, completed: 1, total: 1 });
      return i;
    };
    await iteration(0.5); // older
    await iteration(0.7); // the one
    await iteration(0.4, { model: 'fast' });
    await iteration(0.3, { set: 'dev' });
    await iteration(0.2, { version: 2 });
    await iteration(null); // still running: no cached score
    expect((await list()).items.find((i) => i.id === 'beta')).toMatchObject({
      draft: null,
      published: 1,
      holdoutScore: 0.7,
    });
  });
});
