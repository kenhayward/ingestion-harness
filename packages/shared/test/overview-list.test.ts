import { describe, expect, it } from 'vitest';
import {
  ProjectListQuerySchema,
  listItemFrom,
  queryProjects,
  type GateView,
  type OverviewInputs,
  type ProjectListItem,
} from '../src/index.js';

const gate = (over: Partial<GateView> = {}): GateView => ({
  threshold: 0.9,
  iterationId: null,
  score: null,
  passes: false,
  reason: 'none',
  ...over,
});
const done = (['survey', 'outputs', 'sections', 'steps', 'references'] as const).map((stage) => ({
  stage,
  state: 'accepted' as const,
  completedAt: null,
}));
const inputs = (over: Partial<OverviewInputs> = {}): OverviewInputs => ({
  draft: 2,
  published: 1,
  briefSaved: true,
  samples: { total: 6, preparing: 0, failed: 0 },
  stages: done,
  revise: null,
  evaluation: { running: false },
  gate: gate(),
  ...over,
});
const summary = (id: string, name = id) => ({
  id,
  name,
  createdAt: '2026-10-01T00:00:00.000Z',
  dataPolicy: 'local' as const,
  dataPolicyChangedAt: null,
  dataPolicyChangedBy: null,
  publishThreshold: 0.9,
  thresholdSetBy: null,
  thresholdSetAt: null,
  draft: 2,
  published: 1,
  samples: 6,
});
const item = (
  id: string,
  over: Partial<Parameters<typeof listItemFrom>[0]> = {},
): ProjectListItem =>
  listItemFrom({
    summary: summary(id),
    inputs: inputs(),
    runsUnfinished: 0,
    holdoutScore: null,
    devSamples: 4,
    holdoutSamples: 2,
    lastActivityAt: '2026-10-13T00:00:00.000Z',
    ...over,
  });
const q = (raw: Record<string, string> = {}) => ProjectListQuerySchema.parse(raw);

describe('listItemFrom', () => {
  it('derives stages, phase, next action and flags from the overview inputs', () => {
    const i = item('a', {
      inputs: inputs({
        stages: done.map((s) => (s.stage === 'steps' ? { ...s, state: 'proposed' as const } : s)),
      }),
    });
    expect(i.stages).toHaveLength(11);
    expect(i.stages[5]).toEqual({ stage: 'steps', state: 'proposed' });
    expect(i.phase).toBe('draft');
    expect(i.done).toBe(7); // the mapping, not used, counts as done
    expect(i.next).toEqual({ kind: 'decide', stage: 'steps', label: 'Decide on Pipeline' });
    expect(i.flags).toEqual({ attention: true, running: false, ready: false });
  });

  it('flags running for unfinished runs even when no stage is running', () => {
    expect(item('a', { runsUnfinished: 2 }).flags.running).toBe(true);
    expect(item('a', { inputs: inputs({ evaluation: { running: true } }) }).flags.running).toBe(
      true,
    );
  });

  it('flags ready once the required stages are done, with or without references and evaluation', () => {
    expect(item('a').flags.ready).toBe(true);
    const noReferences = done.map((s) =>
      s.stage === 'references' ? { ...s, state: 'pending' as const } : s,
    );
    expect(item('a', { inputs: inputs({ stages: noReferences }) }).flags.ready).toBe(true);
    const stepsOpen = done.map((s) =>
      s.stage === 'steps' ? { ...s, state: 'pending' as const } : s,
    );
    expect(item('a', { inputs: inputs({ stages: stepsOpen }) }).flags.ready).toBe(false);
    expect(item('a', { inputs: inputs({ draft: null }) }).flags.ready).toBe(false);
  });

  it('flags attention when a holdout run failed the gate', () => {
    expect(
      item('a', { inputs: inputs({ gate: gate({ iterationId: 'i', score: 0.5 }) }) }).flags
        .attention,
    ).toBe(true);
  });
});

describe('ProjectListQuerySchema', () => {
  it('fills the defaults', () => {
    expect(q()).toEqual({ filter: 'all', sort: 'activity', page: 1, size: 25 });
  });
  it.each([
    { size: '30' },
    { page: '0' },
    { sort: 'x' },
    { filter: 'x' },
    { phase: 'x' },
    { policy: 'x' },
    { q: 'x'.repeat(101) },
    { extra: '1' },
  ])('refuses %o', (raw) => {
    expect(ProjectListQuerySchema.safeParse(raw).success).toBe(false);
  });
});

describe('queryProjects', () => {
  const items = [
    item('alpha', {
      summary: { ...summary('alpha', 'Zeta report'), samples: 1 },
      lastActivityAt: '2026-10-10T00:00:00.000Z',
      holdoutScore: 0.8,
      devSamples: 1,
      holdoutSamples: 0,
    }),
    item('beta', {
      summary: { ...summary('beta', 'Alpha invoice'), samples: 7, dataPolicy: 'external' },
      lastActivityAt: '2026-10-12T00:00:00.000Z',
      holdoutScore: null,
      devSamples: 5,
      holdoutSamples: 2,
    }),
    item('gamma', {
      summary: { ...summary('gamma', 'Middle'), samples: 4, draft: null },
      inputs: inputs({ draft: null }),
      lastActivityAt: '2026-10-11T00:00:00.000Z',
      holdoutScore: 0.95,
      devSamples: 3,
      holdoutSamples: 1,
    }),
  ];
  const ids = (page: ReturnType<typeof queryProjects>) => page.items.map((i) => i.id);

  it('sorts by last activity by default', () => {
    expect(ids(queryProjects(items, q()))).toEqual(['beta', 'gamma', 'alpha']);
  });
  it.each([
    ['name', ['beta', 'gamma', 'alpha']],
    ['score', ['alpha', 'gamma', 'beta']],
    ['samples', ['alpha', 'gamma', 'beta']],
  ] as const)('sorts by %s', (sort, expected) => {
    expect(ids(queryProjects(items, q({ sort })))).toEqual(expected);
  });
  it('searches name and id, case-insensitively', () => {
    expect(ids(queryProjects(items, q({ q: 'INVOICE' })))).toEqual(['beta']);
    expect(ids(queryProjects(items, q({ q: 'gam' })))).toEqual(['gamma']);
  });
  it('narrows to the given ids (pinned and recent cards)', () => {
    expect(ids(queryProjects(items, q({ ids: 'gamma, alpha' })))).toEqual(['gamma', 'alpha']);
    expect(
      ProjectListQuerySchema.safeParse({
        ids: Array.from({ length: 21 }, (_, n) => `p${n}`).join(','),
      }).success,
    ).toBe(false);
  });
  it('treats an empty ids as no filter', () => {
    expect(ProjectListQuerySchema.parse({ ids: '' }).ids).toBeUndefined();
    expect(ProjectListQuerySchema.parse({ ids: ',' }).ids).toBeUndefined();
    expect(ids(queryProjects(items, q({ ids: '' })))).toHaveLength(3);
  });
  it('filters by phase and policy', () => {
    expect(ids(queryProjects(items, q({ phase: 'published' })))).toEqual(['gamma']);
    expect(ids(queryProjects(items, q({ policy: 'external' })))).toEqual(['beta']);
  });
  it('counts facets before the filter chip but after search', () => {
    const page = queryProjects(items, q({ filter: 'published' }));
    expect(page.total).toBe(1);
    expect(page.facets).toEqual({
      all: 3,
      attention: 0,
      running: 0,
      ready: 2,
      progress: 2,
      published: 1,
    });
    expect(queryProjects(items, q({ q: 'zeta' })).facets.all).toBe(1);
  });
  it('pages, and answers an empty page past the end with the true total', () => {
    const many = Array.from({ length: 30 }, (_, n) =>
      item(`p${String(n).padStart(2, '0')}`, {
        lastActivityAt: `2026-10-${String(n + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    expect(queryProjects(many, q({ page: '2' })).items).toHaveLength(5);
    expect(queryProjects(many, q({ page: '3' }))).toMatchObject({ items: [], total: 30 });
  });
  it('answers zero everything when nothing matches', () => {
    expect(queryProjects(items, q({ q: 'nothing' }))).toEqual({
      items: [],
      total: 0,
      facets: { all: 0, attention: 0, running: 0, ready: 0, progress: 0, published: 0 },
    });
  });
});

describe('retired projects', () => {
  const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };
  const items: ProjectListItem[] = [item('alpha'), { ...item('beta'), retired: retirement }];
  const ids = (page: ReturnType<typeof queryProjects>) => page.items.map((i) => i.id);

  it('leaves the retirement null in a derived row (the API overlays the live one)', () => {
    expect(item('alpha').retired).toBeNull();
  });
  it('leaves retired projects out by default, from the facets too', () => {
    const page = queryProjects(items, q());
    expect(ids(page)).toEqual(['alpha']);
    expect(page.total).toBe(1);
    expect(page.facets.all).toBe(1);
  });
  it('lists them with retired=include', () => {
    const page = queryProjects(items, q({ retired: 'include' }));
    expect(ids(page)).toEqual(['alpha', 'beta']);
    expect(page.facets.all).toBe(2);
  });
  it('lists them when ids names them (pinned and recent cards)', () => {
    expect(ids(queryProjects(items, q({ ids: 'beta' })))).toEqual(['beta']);
  });
  it('refuses any other retired value', () => {
    expect(ProjectListQuerySchema.safeParse({ retired: 'only' }).success).toBe(false);
  });
});
