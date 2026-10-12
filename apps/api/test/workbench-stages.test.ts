import { describe, expect, it } from 'vitest';
import {
  draftingKey,
  preparedTriageKey,
  type ProposalView,
  type SampleView,
  type StageView,
} from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = Buffer.from('%PDF-1.7\n% sample\n%%EOF\n');
const survey = { summary: 'Letters.', structure: [], variants: [], candidates: [], questions: [] };
const putField = (id: string, description = 'd') => ({
  op: 'putField',
  field: { id, type: 'text', description },
  reason: 'r',
});

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
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

  const start = (stage: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/stages/${stage}` });
  const skip = (stage: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/stages/${stage}/skip` });
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
  const decide = (id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/proposals/${id}/decision`,
      payload,
    });
  const stages = async () =>
    ((await ctx.app.inject('/api/workbench/projects/letter/stages')).json() as StageView[]).map(
      (s) => `${s.stage}:${s.state}`,
    );
  const draft = async () =>
    (await ctx.templates.get('letter', 1))!.definition as ReturnType<typeof letter>;
  return { ...ctx, start, skip, finish, decide, stages, draft };
}

describe('stage order', () => {
  it('blocks a stage until earlier ones are accepted or skipped', async () => {
    const { start, skip, stages } = await project();
    const blocked = await start('outputs');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('finish the survey stage first (accept or skip it)');
    expect((await skip('survey')).statusCode).toBe(201);
    expect((await start('outputs')).statusCode).toBe(202);
    expect(await stages()).toEqual([
      'survey:skipped',
      'outputs:running',
      'sections:pending',
      'steps:pending',
    ]);
    expect((await start('references')).statusCode).toBe(400);
  });

  it('marks later stages stale when an earlier stage is accepted again', async () => {
    const { start, skip, finish, decide, stages } = await project();
    await skip('survey');
    const outputs = (await start('outputs')).json() as ProposalView;
    await finish(outputs.id, 'outputs', { notes: '', changes: [putField('date')] });
    await decide(outputs.id, { decision: 'accepted', changes: [0] });
    const again = (await start('survey')).json() as ProposalView;
    await finish(again.id, 'survey', survey);
    await decide(again.id, { decision: 'accepted' });
    expect(await stages()).toEqual([
      'survey:accepted',
      'outputs:stale',
      'sections:pending',
      'steps:pending',
    ]);
  });
});

describe('change stages', () => {
  it('passes the accepted survey and records the draft the proposal is based on', async () => {
    const { start, finish, decide, repo, workbench } = await project();
    const s = (await start('survey')).json() as ProposalView;
    await finish(s.id, 'survey', survey);
    await decide(s.id, { decision: 'accepted' });
    const p = (await start('outputs')).json() as ProposalView;
    expect(repo.draftJobs.get(p.id)!.params).toMatchObject({
      stage: 'outputs',
      survey,
      draft: letter(1),
    });
    const [record] = await workbench.listProposals('letter');
    expect(record).toMatchObject({ baseVersion: 1, baseDefinition: letter(1) });
  });

  it('applies only the accepted changes to the draft', async () => {
    const { start, skip, finish, decide, draft } = await project();
    await skip('survey');
    const p = (await start('outputs')).json() as ProposalView;
    await finish(p.id, 'outputs', {
      notes: 'n',
      changes: [putField('date'), putField('sender', 'Who')],
    });
    const res = await decide(p.id, { decision: 'accepted', changes: [0] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'partially_accepted', acceptedChanges: [0] });
    const fields = (await draft()).outputs.fields;
    expect(fields).toEqual([
      { id: 'sender', type: 'text' },
      { id: 'date', type: 'text', description: 'd' },
    ]);
  });

  it('refuses changes whose target was edited since the proposal, but applies the others', async () => {
    const { start, skip, finish, decide, draft, templates } = await project();
    await skip('survey');
    const p = (await start('outputs')).json() as ProposalView;
    await finish(p.id, 'outputs', {
      notes: '',
      changes: [putField('date'), putField('sender', 'Who')],
    });
    const edited = letter(1);
    edited.outputs.fields[0] = { id: 'sender', type: 'text', description: 'hand-written' } as never;
    await templates.updateDraft('letter', 1, edited);
    const clash = await decide(p.id, { decision: 'accepted', changes: [0, 1] });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toContain('where these changes apply: 2');
    const ok = await decide(p.id, { decision: 'accepted', changes: [0] });
    expect(ok.statusCode).toBe(200);
    expect((await draft()).outputs.fields.map((f) => f.id)).toEqual(['sender', 'date']);
  });

  it('validates decisions', async () => {
    const { start, skip, finish, decide } = await project();
    const s = (await start('survey')).json() as ProposalView;
    await finish(s.id, 'survey', survey);
    expect((await decide(s.id, { decision: 'accepted', changes: [0] })).statusCode).toBe(400);
    await decide(s.id, { decision: 'rejected' });
    await skip('survey');
    const p = (await start('outputs')).json() as ProposalView;
    await finish(p.id, 'outputs', { notes: '', changes: [putField('date')] });
    expect((await decide(p.id, { decision: 'accepted' })).statusCode).toBe(400);
    expect((await decide(p.id, { decision: 'accepted', changes: [3] })).statusCode).toBe(400);
    expect((await decide(p.id, { decision: 'rejected', changes: [0] })).statusCode).toBe(400);
    expect((await decide(p.id, { decision: 'rejected' })).json()).toMatchObject({
      status: 'rejected',
    });
  });

  it('reports a body with a foreign op as unreadable', async () => {
    const { app, start, skip, finish } = await project();
    await skip('survey');
    const p = (await start('outputs')).json() as ProposalView;
    await finish(p.id, 'outputs', {
      notes: '',
      changes: [{ op: 'removeStep', id: 'head', reason: 'r' }],
    });
    const [view] = (
      await app.inject('/api/workbench/projects/letter/proposals')
    ).json() as ProposalView[];
    expect(view).toMatchObject({ status: 'failed', error: 'result unreadable' });
  });
});

describe('accepting when the draft is no longer open', () => {
  it('answers 409 and leaves the proposal undecided so it can be accepted again', async () => {
    const { start, skip, finish, decide, templates, workbench } = await project();
    await skip('survey');
    const p = (await start('outputs')).json() as ProposalView;
    await finish(p.id, 'outputs', { notes: '', changes: [putField('date')] });
    const real = templates.updateDraft.bind(templates);
    let closed = true;
    templates.updateDraft = async (...args: Parameters<typeof real>) =>
      closed ? null : real(...args);
    const res = await decide(p.id, { decision: 'accepted', changes: [0] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      'the draft is no longer open; start the next version and re-run the stage',
    );
    const [record] = await workbench.listProposals('letter');
    expect(record!.decision).toBeNull();
    closed = false;
    expect((await decide(p.id, { decision: 'accepted', changes: [0] })).statusCode).toBe(200);
  });
});
