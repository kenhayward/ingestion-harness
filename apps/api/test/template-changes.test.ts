import { describe, expect, it, vi } from 'vitest';
import { stringify as toYaml } from 'yaml';
import {
  draftingKey,
  preparedTriageKey,
  type ProposalView,
  type SampleView,
  type TemplateChange,
  type TemplateChangeInput,
} from '@ih/shared';
import { handEditedAt } from '../src/templates/changes.js';
import { MemoryTemplateRepo } from '../src/templates/repo.js';
import { letter, multipart, testApp } from './helpers.js';

const hand = (summary = 'Added field a'): TemplateChangeInput => ({
  source: 'hand',
  stage: null,
  proposalId: null,
  summary,
  diff: ['+ a'],
  by: 'Ken',
});
const started: TemplateChangeInput = {
  source: 'started',
  stage: null,
  proposalId: null,
  summary: 'Draft v1 created',
  diff: [],
  by: null,
};

describe('MemoryTemplateRepo change log (TP1)', () => {
  it('logs a draft write with the write, newest first', async () => {
    const repo = new MemoryTemplateRepo();
    await repo.create('letter', 1, { id: 'letter', version: 1 }, 'draft', started);
    await repo.updateDraft(
      'letter',
      1,
      { id: 'letter', version: 1, name: 'A' },
      { change: hand() },
    );
    await repo.updateDraft('letter', 1, { id: 'letter', version: 1, name: 'B' }); // no change given
    const changes = await repo.listChanges('letter', 1);
    expect(changes.map((c) => [c.source, c.summary, c.by])).toEqual([
      ['hand', 'Added field a', 'Ken'],
      ['started', 'Draft v1 created', null],
    ]);
    expect(changes[0]).toMatchObject({ version: 1, stage: null, proposalId: null, diff: ['+ a'] });
    expect(Date.parse(changes[0]!.at)).not.toBeNaN();
  });

  it('refuses a stale base: nothing is written or logged', async () => {
    const repo = new MemoryTemplateRepo();
    const v1 = await repo.create('letter', 1, { id: 'letter', version: 1 }, 'draft');
    const a = await repo.updateDraft(
      'letter',
      1,
      { id: 'letter', version: 1, name: 'A' },
      { expectedUpdatedAt: v1.updatedAt, change: hand() },
    );
    expect(a!.updatedAt > v1.updatedAt).toBe(true); // the clock always moves
    const stale = await repo.updateDraft(
      'letter',
      1,
      { id: 'letter', version: 1, name: 'B' },
      { expectedUpdatedAt: v1.updatedAt, change: hand('stale') },
    );
    expect(stale).toBeNull();
    expect((await repo.get('letter', 1))!.definition).toMatchObject({ name: 'A' });
    expect((await repo.listChanges('letter', 1)).map((c) => c.summary)).toEqual(['Added field a']);
  });

  it('never logs for a published version, and a deleted draft takes its log', async () => {
    const repo = new MemoryTemplateRepo();
    await repo.create('letter', 1, { id: 'letter', version: 1 }, 'published', started);
    expect(await repo.listChanges('letter', 1)).toEqual([]);
    expect(await repo.updateDraft('letter', 1, { name: 'x' }, { change: hand() })).toBeNull();
    expect(await repo.listChanges('letter', 1)).toEqual([]);
    await repo.create('letter', 2, { id: 'letter', version: 2 }, 'draft', started);
    await repo.create('other', 1, { id: 'other', version: 1 }, 'draft', started);
    expect(await repo.deleteDraft('letter', 2)).toBe(true);
    expect(await repo.listChanges('letter', 2)).toEqual([]);
    expect(await repo.listChanges('other', 1)).toHaveLength(1);
  });
});

const json = (method: 'POST' | 'PUT', url: string, payload: object) => ({ method, url, payload });
const rows = async (
  templates: { listChanges: MemoryTemplateRepo['listChanges'] },
  id: string,
  version: number,
) => (await templates.listChanges(id, version)).map((c) => [c.source, c.summary, c.diff]);

describe('the draft change log through the routes (TP1)', () => {
  it('logs a hand save with what changed; an unchanged save logs nothing', async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    const { record } = (await app.inject('/api/templates/letter/versions/1')).json();
    const definition = {
      ...record.definition,
      outputs: { fields: [{ id: 'due_date', type: 'date' }], tables: [] },
    };
    const put = () => app.inject(json('PUT', '/api/templates/letter/versions/1', { definition }));
    expect((await put()).statusCode).toBe(200);
    expect((await put()).statusCode).toBe(200);
    expect(await rows(templates, 'letter', 1)).toEqual([
      ['hand', 'Added field due_date', ['+ due_date']],
      ['started', 'Draft v1 created', []],
    ]);
    expect((await templates.listChanges('letter', 1))[0]!.by).toBeNull(); // no access control here
  });

  it('refuses a save from a stale base with 409 and writes nothing', async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    const first = (await app.inject('/api/templates/letter/versions/1')).json().record;
    const save = (name: string, baseUpdatedAt?: string) =>
      app.inject(
        json('PUT', '/api/templates/letter/versions/1', {
          definition: { ...first.definition, name },
          ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }),
        }),
      );
    expect((await save('A', first.updatedAt)).statusCode).toBe(200);
    const stale = await save('B', first.updatedAt);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe(
      'the draft changed since you opened it; reload it to see the changes',
    );
    expect((await templates.get('letter', 1))!.definition.name).toBe('A');
    expect((await rows(templates, 'letter', 1)).map(([, summary]) => summary)).toEqual([
      'Changed the name',
      'Draft v1 created',
    ]);
    expect((await save('C', 'yesterday')).statusCode).toBe(400);
    expect((await save('C')).statusCode).toBe(200); // no base: last write wins, as before
  });

  it('logs the start of a draft: a new type and the next version', async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    await app.inject(json('PUT', '/api/templates/letter/versions/1', { definition: letter(1) }));
    await app.inject(json('POST', '/api/templates/letter/versions/1/publish', {}));
    expect((await app.inject(json('POST', '/api/templates/letter/drafts', {}))).statusCode).toBe(
      201,
    );
    expect(await rows(templates, 'letter', 2)).toEqual([
      ['started', 'Draft v2 created from published v1', []],
    ]);
  });

  it('logs an imported draft, never a published import', async () => {
    const { app, templates } = await testApp();
    const yaml = (version: number) => toYaml({ ...letter(version), id: 'memo' });
    await app.inject(json('POST', '/api/templates/import', { yaml: yaml(1) }));
    await app.inject(json('POST', '/api/templates/import', { yaml: yaml(2), publish: true }));
    expect(await rows(templates, 'memo', 1)).toEqual([['import', 'Imported from YAML', []]]);
    expect(await rows(templates, 'memo', 2)).toEqual([]);
  });

  it("logs a new Workbench project's draft, for a new and for an existing type", async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/workbench/projects', { id: 'memo', name: 'Memo' }));
    expect(await rows(templates, 'memo', 1)).toEqual([['started', 'Draft v1 created', []]]);
    await templates.create('letter', 1, letter(1), 'published');
    await app.inject(json('POST', '/api/workbench/projects', { id: 'letter' }));
    expect(await rows(templates, 'letter', 2)).toEqual([
      ['started', 'Draft v2 created from published v1', []],
    ]);
  });
});

/** A Workbench project with one prepared dev sample (as in workbench-stages.test.ts). */
async function project() {
  const ctx = await testApp();
  await ctx.app.inject(json('POST', '/api/workbench/projects', { id: 'letter', name: 'Letter' }));
  await ctx.templates.updateDraft('letter', 1, letter(1)); // no outputs.tables, as imported YAML
  const pdf = Buffer.from('%PDF-1.7\n% sample\n%%EOF\n');
  const s = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/samples',
      ...multipart({ role: 'dev' }, { filename: 's1.pdf', content: pdf }),
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
  const finish = async (id: string, stage: string, body: unknown) => {
    ctx.repo.draftJobs.set(id, { ...ctx.repo.draftJobs.get(id)!, status: 'succeeded' });
    const result = { stage, model: 'local/big', body, usage: { inputTokens: 1, outputTokens: 1 } };
    await ctx.store.put(
      'runs',
      draftingKey('letter', id),
      Buffer.from(JSON.stringify(result)),
      'application/json',
    );
  };
  return { ...ctx, finish };
}

describe('Workbench writes to the draft (TP1)', () => {
  const putField = (id: string, description = 'd') => ({
    op: 'putField',
    field: { id, type: 'text', description },
    reason: 'r',
  });

  it('logs an applied proposal with its stage and id, and how much of it was applied', async () => {
    const { app, templates, finish } = await project();
    await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/survey/skip' });
    const p = (
      await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/outputs' })
    ).json() as ProposalView;
    await finish(p.id, 'outputs', {
      notes: '',
      changes: [putField('date'), putField('sender', 'Who')],
    });
    const res = await app.inject(
      json('POST', `/api/workbench/projects/letter/proposals/${p.id}/decision`, {
        decision: 'accepted',
        changes: [0],
      }),
    );
    expect(res.statusCode).toBe(200);
    const [entry] = await templates.listChanges('letter', 1);
    expect(entry).toMatchObject({
      source: 'proposal',
      stage: 'outputs',
      proposalId: p.id,
      summary: 'Added field date (1 of 2 proposed changes)',
      diff: ['+ date'],
    });
  });

  it('logs nothing for a proposal or a restore that changes nothing', async () => {
    const { app, templates, finish, workbench } = await project();
    const count = async () => (await templates.listChanges('letter', 1)).length;
    const before = await count();
    await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/survey/skip' });
    const p = (
      await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/outputs' })
    ).json() as ProposalView;
    // The draft has this field already, and no `tables` key.
    await finish(p.id, 'outputs', {
      notes: '',
      changes: [{ op: 'putField', field: { id: 'sender', type: 'text' }, reason: 'r' }],
    });
    const decided = await app.inject(
      json('POST', `/api/workbench/projects/letter/proposals/${p.id}/decision`, {
        decision: 'accepted',
        changes: [0],
      }),
    );
    expect(decided.statusCode).toBe(200);
    const iteration = await workbench.createIteration({
      projectId: 'letter',
      templateVersion: 1,
      definition: letter(1),
      briefVersion: null,
      set: 'dev',
      model: null,
      jobIds: [],
    });
    const restored = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/iterations/${iteration.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(await count()).toBe(before);
  });

  /** After the next read of the draft, a hand save lands: the write that follows is stale. */
  function handSaveAfterNextRead(templates: MemoryTemplateRepo) {
    const get = templates.get.bind(templates);
    let armed = true;
    vi.spyOn(templates, 'get').mockImplementation(async (id, version) => {
      const record = await get(id, version);
      if (armed && record && record.status === 'draft') {
        armed = false;
        await templates.updateDraft(
          id,
          version,
          { ...record.definition, name: 'Hand' },
          { change: hand('Changed the name') },
        );
      }
      return record;
    });
  }

  it('refuses to apply a proposal over a hand save made meanwhile, writing and logging nothing', async () => {
    const { app, templates, finish } = await project();
    await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/survey/skip' });
    const p = (
      await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/outputs' })
    ).json() as ProposalView;
    await finish(p.id, 'outputs', { notes: '', changes: [putField('date')] });
    const before = (await templates.listChanges('letter', 1)).length;
    handSaveAfterNextRead(templates);
    const decide = () =>
      app.inject(
        json('POST', `/api/workbench/projects/letter/proposals/${p.id}/decision`, {
          decision: 'accepted',
          changes: [0],
        }),
      );
    const refused = await decide();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('the draft changed while applying; try again');
    const draft = (await templates.get('letter', 1))!.definition;
    expect(draft.name).toBe('Hand');
    expect(draft.outputs?.fields?.map((f: { id: string }) => f.id)).not.toContain('date');
    // Only the hand save was logged on top of what was there.
    expect((await templates.listChanges('letter', 1)).length).toBe(before + 1);
    // The proposal is still undecided: trying again applies it on top of the hand save.
    expect((await decide()).statusCode).toBe(200);
    expect((await templates.get('letter', 1))!.definition.name).toBe('Hand');
  });

  it('refuses to restore over a hand save made meanwhile, writing and logging nothing', async () => {
    const { app, templates, workbench } = await project();
    const iteration = await workbench.createIteration({
      projectId: 'letter',
      templateVersion: 1,
      definition: { ...letter(1), name: 'Old letter' },
      briefVersion: null,
      set: 'dev',
      model: null,
      jobIds: [],
    });
    const before = (await templates.listChanges('letter', 1)).length;
    handSaveAfterNextRead(templates);
    const res = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/iterations/${iteration.id}/restore`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('the draft changed while applying; try again');
    expect((await templates.get('letter', 1))!.definition.name).toBe('Hand');
    expect((await templates.listChanges('letter', 1)).length).toBe(before + 1);
  });

  it('logs a restored iteration', async () => {
    const { app, templates, workbench } = await project();
    const iteration = await workbench.createIteration({
      projectId: 'letter',
      templateVersion: 1,
      definition: { ...letter(1), name: 'Old letter' },
      briefVersion: null,
      set: 'dev',
      model: null,
      jobIds: [],
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/iterations/${iteration.id}/restore`,
    });
    expect(res.statusCode).toBe(200);
    const [entry] = await templates.listChanges('letter', 1);
    expect(entry).toMatchObject({
      source: 'restore',
      stage: null,
      summary: `Changed the name (from the dev evaluation of ${iteration.createdAt.slice(0, 10)})`,
      diff: ['Letter → Old letter'],
    });
  });
});

describe('GET /api/workbench/projects/:id/draft/changes', () => {
  it("lists the open draft's changes newest first", async () => {
    const { app } = await testApp();
    await app.inject(json('POST', '/api/workbench/projects', { id: 'letter', name: 'Letter' }));
    await app.inject(json('PUT', '/api/templates/letter/versions/1', { definition: letter(1) }));
    const res = await app.inject('/api/workbench/projects/letter/draft/changes');
    expect(res.statusCode).toBe(200);
    expect((res.json() as TemplateChange[]).map((c) => [c.source, c.version])).toEqual([
      ['hand', 1],
      ['started', 1],
    ]);
  });

  it('is empty without an open draft and 404s an unknown project', async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/workbench/projects', { id: 'letter', name: 'Letter' }));
    await templates.publish('letter', 1);
    expect((await app.inject('/api/workbench/projects/letter/draft/changes')).json()).toEqual([]);
    const missing = await app.inject('/api/workbench/projects/nope/draft/changes');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'project not found' });
  });
});

describe('handEditedAt', () => {
  const entry = (source: TemplateChange['source'], at: string): TemplateChange => ({
    id: at,
    version: 1,
    at,
    source,
    stage: source === 'proposal' ? 'outputs' : null,
    proposalId: null,
    summary: 's',
    diff: [],
    by: null,
  });
  const record = { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };
  it.each<[string, TemplateChange[], string | null]>([
    ['no log (before migration 0029): the last write', [], record.updatedAt],
    [
      'the newest hand change',
      [entry('proposal', 'c'), entry('hand', 'b'), entry('hand', 'a')],
      'b',
    ],
    ['no hand change yet', [entry('proposal', 'b'), entry('started', 'a')], null],
  ])('%s', (_name, changes, expected) => expect(handEditedAt(changes, record)).toBe(expected));
  it('is null without a version', () => expect(handEditedAt([], null)).toBeNull());
});
