import { describe, expect, it } from 'vitest';
import {
  draftingKey,
  ontologySuggestionsKey,
  type OntologySuggestionsView,
  type SuggestionRecord,
  type SuggestParams,
} from '@ih/shared';
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { MemoryRepo } from '../src/repositories/memory.js';
import { SEGMENT_PRIORITY } from '../src/repositories/types.js';
import { multipart, testApp } from './helpers.js';

const params: SuggestParams = {
  surveyProposalId: 'p1',
  candidates: [{ name: 'batch_number', description: '', kind: 'field' }],
  library: [{ id: 'domain', version: 1, label: 'Domain', terms: 3 }],
  pinned: [],
  dataPolicy: 'local',
};

describe('suggest jobs (repository)', () => {
  it('keeps one per project and returns the replaced ids', async () => {
    const repo = new MemoryRepo();
    const first = await repo.createSuggestJob('letter', params);
    const second = await repo.createSuggestJob('letter', params);
    expect(second.removed).toEqual([first.job.id]);
    expect(repo.priorities.get(second.job.id)).toBe(SEGMENT_PRIORITY);
    expect((await repo.latestSuggestJob('letter'))?.id).toBe(second.job.id);
    expect((await repo.latestSuggestJob('letter'))?.params).toEqual(params);
    expect(await repo.latestSuggestJob('other')).toBeNull();
  });
});

const SURVEY = {
  summary: 's',
  structure: [],
  variants: [],
  candidates: [
    {
      name: 'batch_number',
      description: 'Batch',
      where: 'top',
      kind: 'field',
      seenIn: { n: 1, of: 1 },
    },
  ],
  questions: [],
};
const STATS = {
  triples: 10,
  classes: 2,
  properties: 1,
  concepts: 0,
  schemes: 0,
  shapes: 0,
  imported: 0,
};

/** A project, one ready ontology (domain v1, 3 terms) and helpers for surveys and records. */
async function setup() {
  const ontologies = new MemoryOntologyRepo();
  const ctx = await testApp({ ontologies });
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  const upload = (content: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/ontologies',
      ...multipart(
        { id: 'domain', label: 'Domain' },
        { filename: 'domain.ttl', content: Buffer.from(content), contentType: 'text/turtle' },
      ),
    });
  expect((await upload('# domain\n')).statusCode).toBe(202);
  ontologies.markReady('domain', 1, { stats: STATS });
  /** A finished survey proposal, optionally decided. */
  const survey = async (decision: 'accepted' | 'rejected' | null = null) => {
    const job = await ctx.repo.createDraftJob('letter', { stage: 'survey' });
    ctx.repo.draftJobs.set(job.id, { ...ctx.repo.draftJobs.get(job.id)!, status: 'succeeded' });
    await ctx.app.deps.workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'survey',
      briefVersion: null,
      baseVersion: null,
      baseDefinition: null,
      feedbackIds: null,
    });
    const result = {
      stage: 'survey',
      model: 'm',
      body: SURVEY,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    await ctx.store.put(
      'runs',
      draftingKey('letter', job.id),
      Buffer.from(JSON.stringify(result)),
      'application/json',
    );
    if (decision) await ctx.app.deps.workbench.decideProposal('letter', job.id, decision);
    return job.id;
  };
  const record = (surveyProposalId: string, libraryKey = 'lexical|domain@1'): SuggestionRecord => ({
    surveyProposalId,
    createdAt: '2026-10-15T10:00:00Z',
    candidates: 1,
    libraryKey,
    suggestions: [],
    pinned: [],
    alsoMatched: [],
    uncovered: ['batch_number'],
    notes: [],
  });
  const put = (jobId: string, r: SuggestionRecord) =>
    ctx.store.put(
      'runs',
      ontologySuggestionsKey('letter', jobId),
      Buffer.from(JSON.stringify(r)),
      'application/json',
    );
  const get = async () =>
    (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/workbench/projects/letter/ontology-suggestions',
      })
    ).json() as OntologySuggestionsView;
  const refresh = () =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/ontology-suggestions' });
  const finish = async (status: 'succeeded' | 'needs_review', error: string | null = null) => {
    const job = (await ctx.repo.latestSuggestJob('letter'))!;
    ctx.repo.suggestJobs.set(job.id, { ...ctx.repo.suggestJobs.get(job.id)!, status, error });
    return job;
  };
  return { ...ctx, ontologies, upload, survey, record, put, get, refresh, finish };
}

describe('ontology suggestion routes', () => {
  it('has no record before a survey, and refuses a refresh', async () => {
    const t = await setup();
    expect(await t.get()).toEqual({ record: null, running: false, failed: null, stale: null });
    const res = await t.refresh();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'run the survey first' });
  });

  it("serves the survey job's own record, then a refresh of it", async () => {
    const t = await setup();
    const id = await t.survey();
    await t.put(id, t.record(id));
    expect((await t.get()).record?.surveyProposalId).toBe(id);
    const res = await t.refresh();
    expect(res.statusCode).toBe(202);
    expect(res.json().running).toBe(true);
    expect((await t.repo.latestSuggestJob('letter'))!.params).toEqual({
      surveyProposalId: id,
      candidates: [{ name: 'batch_number', description: 'Batch', kind: 'field' }],
      library: [{ id: 'domain', version: 1, label: 'Domain', terms: 3 }],
      pinned: [],
      dataPolicy: 'local',
    });
    const job = await t.finish('succeeded');
    await t.put(job.id, { ...t.record(id), uncovered: [] });
    const view = await t.get();
    expect(view).toMatchObject({ running: false, failed: null, stale: null });
    expect(view.record?.uncovered).toEqual([]);
  });

  it('sends the brief vocabulary pins with a refresh', async () => {
    const t = await setup();
    await t.survey();
    await t.app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/brief',
      payload: {
        ontologies: [
          { ontologyId: 'qudt', version: 1, role: 'vocabulary' },
          { ontologyId: 'shp', version: 1, role: 'shapes' },
        ],
      },
    });
    await t.refresh();
    expect((await t.repo.latestSuggestJob('letter'))!.params.pinned).toEqual([
      { ontologyId: 'qudt', version: 1 },
    ]);
  });

  it('says when the library changed', async () => {
    const t = await setup();
    const id = await t.survey();
    await t.put(id, t.record(id, 'lexical|domain@1,qudt@1'));
    expect((await t.get()).stale).toBe('library');
  });

  it('says when the record is from an earlier survey', async () => {
    const t = await setup();
    const first = await t.survey();
    await t.put(first, t.record(first));
    await t.refresh();
    const job = await t.finish('succeeded');
    await t.put(job.id, t.record(first));
    await t.survey(); // newer, and without its own record
    const view = await t.get();
    expect(view.stale).toBe('survey');
    expect(view.record?.surveyProposalId).toBe(first);
  });

  it('ignores a rejected survey proposal', async () => {
    const t = await setup();
    const accepted = await t.survey('accepted');
    await t.put(accepted, t.record(accepted));
    await t.survey('rejected');
    expect((await t.get()).stale).toBeNull();
    await t.refresh();
    expect((await t.repo.latestSuggestJob('letter'))!.params.surveyProposalId).toBe(accepted);
  });

  it('shows a failed refresh', async () => {
    const t = await setup();
    await t.survey();
    await t.refresh();
    await t.finish('needs_review', 'index down');
    expect((await t.get()).failed).toBe('index down');
  });

  it('refuses a refresh with no ready ontology', async () => {
    const t = await setup();
    await t.survey();
    await t.app.inject({
      method: 'PATCH',
      url: '/api/ontologies/domain',
      payload: { retired: true },
    });
    const res = await t.refresh();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'the ontology library has no ready versions' });
  });

  it('offers the newest ready version when the latest is still importing', async () => {
    const t = await setup();
    expect((await t.upload('# domain, changed\n')).statusCode).toBe(202);
    await t.survey();
    await t.refresh();
    expect((await t.repo.latestSuggestJob('letter'))!.params.library).toEqual([
      { id: 'domain', version: 1, label: 'Domain', terms: 3 },
    ]);
  });

  it('404s an unknown project and refuses a retired type', async () => {
    const t = await setup();
    const unknown = await t.app.inject({
      method: 'GET',
      url: '/api/workbench/projects/nope/ontology-suggestions',
    });
    expect(unknown.statusCode).toBe(404);
    await t.survey();
    await t.app.inject({ method: 'PUT', url: '/api/specs/letter/retirement' });
    const res = await t.refresh();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/is retired/);
  });
});
