import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_PROGRESS_EVENT,
  DraftChangeSchema,
  DraftProgressSchema,
  answeredFeedback,
  applyChanges,
  blockingStage,
  conflictingChanges,
  firstIncomplete,
  parseChangeBody,
  referencesStage,
  stableJson,
  stageStates,
  mappingKeepUpTo,
  mappingStage,
  type DraftChange,
  type StageView,
} from '../src/index.js';

const cases = JSON.parse(
  readFileSync(new URL('./fixtures/draft-changes.json', import.meta.url), 'utf8'),
) as {
  name: string;
  definition: Record<string, unknown>;
  changes: unknown[];
  expected: Record<string, unknown>;
}[];

describe('applyChanges (fixture shared with worker/tests/test_draft_changes.py)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    for (const change of c.changes) expect(DraftChangeSchema.safeParse(change).success).toBe(true);
    expect(applyChanges(c.definition, c.changes as DraftChange[])).toStrictEqual(c.expected);
  });

  it('never mutates its input', () => {
    const c = cases[0]!;
    const before = JSON.stringify(c.definition);
    applyChanges(c.definition, c.changes as DraftChange[]);
    expect(JSON.stringify(c.definition)).toBe(before);
  });
});

describe('change bodies', () => {
  const field = { op: 'putField', field: { id: 'a', type: 'text' }, reason: 'r' };
  const step = {
    op: 'putStep',
    step: { type: 'extract', id: 's', fields: ['a'], sections: ['all'] },
    reason: 'r',
  };

  it('accepts only the ops of the stage', () => {
    expect(parseChangeBody('outputs', { notes: '', changes: [field] })?.changes).toHaveLength(1);
    expect(parseChangeBody('outputs', { notes: '', changes: [step] })).toBeNull();
    expect(parseChangeBody('steps', { notes: '', changes: [step] })?.changes[0]).toMatchObject({
      op: 'putStep',
    });
  });

  it('rejects unknown keys and invalid items', () => {
    expect(parseChangeBody('outputs', { notes: '', changes: [], extra: 1 })).toBeNull();
    const badEnum = { op: 'putField', field: { id: 'a', type: 'enum' }, reason: 'r' };
    expect(parseChangeBody('outputs', { notes: '', changes: [badEnum] })).toBeNull();
  });
});

describe('conflicts', () => {
  const base = {
    outputs: { fields: [{ id: 'sender', type: 'text', description: 'x' }], tables: [] },
    document: { sections: [{ id: 'all', anchor: '\\A' }] },
    pipeline: [],
  };
  const change = (id: string): DraftChange => ({
    op: 'putField',
    field: { id, type: 'text' },
    reason: 'r',
  });

  it('ignores key order (jsonb reorders keys)', () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      stableJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
    const reordered = {
      pipeline: [],
      document: { sections: [{ anchor: '\\A', id: 'all' }] },
      outputs: { tables: [], fields: [{ description: 'x', type: 'text', id: 'sender' }] },
    };
    expect(conflictingChanges(base, reordered, [change('sender')])).toEqual([]);
  });

  it('flags only changes whose target was edited since the proposal', () => {
    const edited = {
      ...base,
      outputs: { fields: [{ id: 'sender', type: 'text', description: 'edited' }], tables: [] },
    };
    expect(conflictingChanges(base, edited, [change('new_one'), change('sender')])).toEqual([1]);
  });
});

describe('stage states', () => {
  const t = (n: number) => `2026-10-12T10:00:0${n}.000Z`;
  const proposal = (
    stage: 'survey' | 'outputs' | 'sections' | 'steps',
    status: 'running' | 'ready' | 'failed' | 'accepted' | 'partially_accepted' | 'rejected',
    createdAt: string,
    decidedAt: string | null = null,
  ) => ({ stage, status, createdAt, decidedAt });

  it('starts pending and blocks later stages until earlier ones are complete', () => {
    const states = stageStates([], []);
    expect(states.map((s) => s.state)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(blockingStage(states, 'survey')).toBeNull();
    expect(blockingStage(states, 'outputs')).toBe('survey');
  });

  it('treats a skip as complete and shows running and proposed work', () => {
    const states = stageStates(
      [proposal('outputs', 'ready', t(2)), proposal('sections', 'running', t(3))],
      [{ stage: 'survey', skippedAt: t(1) }],
    );
    expect(states.map((s) => s.state)).toEqual(['skipped', 'proposed', 'running', 'pending']);
    expect(blockingStage(states, 'outputs')).toBeNull();
    expect(blockingStage(states, 'sections')).toBe('outputs');
  });

  it('marks later stages stale when an earlier stage completes after them, keeping them complete', () => {
    const states = stageStates(
      [
        proposal('survey', 'accepted', t(1), t(2)),
        proposal('outputs', 'partially_accepted', t(3), t(4)),
        proposal('survey', 'accepted', t(5), t(6)),
      ],
      [],
    );
    expect(states.map((s) => s.state)).toEqual(['accepted', 'stale', 'pending', 'pending']);
    expect(blockingStage(states, 'sections')).toBeNull();
  });

  it('a rejected or failed latest proposal leaves the earlier completion in place', () => {
    const states = stageStates(
      [
        proposal('survey', 'accepted', t(1), t(2)),
        proposal('survey', 'rejected', t(3), t(4)),
        proposal('outputs', 'failed', t(5)),
      ],
      [],
    );
    expect(states.map((s) => s.state)).toEqual(['accepted', 'pending', 'pending', 'pending']);
  });

  it('keeps the latest skip after a later run and acceptance (SV1)', () => {
    const states = stageStates(
      [proposal('survey', 'accepted', t(3), t(4))],
      [
        { stage: 'survey', skippedAt: t(2) },
        { stage: 'survey', skippedAt: t(1) },
      ],
    );
    expect(states[0]).toEqual({
      stage: 'survey',
      state: 'accepted',
      completedAt: t(4),
      skippedAt: t(2),
    });
    expect(states[1]).toEqual({
      stage: 'outputs',
      state: 'pending',
      completedAt: null,
      skippedAt: null,
    });
  });

  describe('confirmations (SC1)', () => {
    const base = [
      proposal('survey', 'accepted', t(1), t(1)),
      proposal('outputs', 'accepted', t(2), t(2)),
      proposal('sections', 'accepted', t(3), t(3)),
      proposal('outputs', 'accepted', t(4), t(4)), // outputs changed after sections
      proposal('steps', 'accepted', t(5), t(5)),
    ];
    const keep = { stage: 'sections' as const, confirmedAt: t(6), upTo: t(4) };

    it.each<[string, Parameters<typeof stageStates>[2], string[]]>([
      [
        'without a confirmation sections is stale',
        [],
        ['accepted', 'accepted', 'stale', 'accepted'],
      ],
      [
        'a confirmation covering the change clears it',
        [keep],
        ['accepted', 'accepted', 'accepted', 'accepted'],
      ],
      [
        'a confirmation older than the change does not',
        [{ ...keep, upTo: t(3) }],
        ['accepted', 'accepted', 'stale', 'accepted'],
      ],
      [
        "another stage's confirmation does not",
        [{ ...keep, stage: 'steps' }],
        ['accepted', 'accepted', 'stale', 'accepted'],
      ],
    ])('%s', (_name, confirms, expected) => {
      expect(stageStates(base, [], confirms).map((s) => s.state)).toEqual(expected);
    });

    it('never moves completedAt, so later stages do not go stale', () => {
      const kept = stageStates(base, [], [keep]);
      expect(kept[2]).toEqual({
        stage: 'sections',
        state: 'accepted',
        completedAt: t(3),
        skippedAt: null,
      });
      expect(kept[3]).toMatchObject({ stage: 'steps', state: 'accepted', completedAt: t(5) });
    });

    it('goes stale again when an earlier stage completes after it', () => {
      const later = stageStates([...base, proposal('survey', 'accepted', t(7), t(7))], [], [keep]);
      expect(later.map((s) => s.state)).toEqual(['accepted', 'stale', 'stale', 'stale']);
    });

    it('a kept skip stays a skip', () => {
      const states = stageStates(
        [proposal('survey', 'accepted', t(1), t(1)), proposal('survey', 'accepted', t(3), t(3))],
        [{ stage: 'outputs', skippedAt: t(2) }],
        [{ stage: 'outputs', confirmedAt: t(4), upTo: t(3) }],
      );
      expect(states[1]).toEqual({
        stage: 'outputs',
        state: 'skipped',
        completedAt: t(2),
        skippedAt: t(2),
      });
    });
  });

  describe('accepting a proposal with no changes', () => {
    const none = (createdAt: string, decidedAt: string) => ({
      ...proposal('sections', 'accepted', createdAt, decidedAt),
      acceptedChanges: [] as number[],
    });
    const base = [
      proposal('survey', 'accepted', t(1), t(1)),
      proposal('outputs', 'accepted', t(2), t(2)),
      proposal('sections', 'accepted', t(3), t(3)),
      proposal('outputs', 'accepted', t(4), t(4)), // outputs changed after sections
      proposal('steps', 'accepted', t(5), t(5)),
    ];

    it('keeps an already complete stage: no longer stale, later stages untouched', () => {
      const states = stageStates([...base, none(t(6), t(7))], []);
      expect(states.map((s) => s.state)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
      expect(states[2]).toMatchObject({ stage: 'sections', completedAt: t(3) });
    });

    it('completes a stage that was never complete', () => {
      const states = stageStates([...base.slice(0, 2), none(t(3), t(4))], []);
      expect(states[2]).toMatchObject({ state: 'accepted', completedAt: t(4) });
    });

    it('keeps a skipped stage skipped', () => {
      const states = stageStates(
        [...base.slice(0, 2), none(t(5), t(6))],
        [{ stage: 'sections', skippedAt: t(3) }],
      );
      expect(states[2]).toMatchObject({ state: 'skipped', completedAt: t(3) });
    });

    it('a later earlier-stage completion makes it stale again', () => {
      const states = stageStates(
        [...base, none(t(6), t(7)), proposal('outputs', 'accepted', t(8), t(8))],
        [],
      );
      expect(states[2]!.state).toBe('stale');
    });

    it('a survey acceptance (no change list) still completes the stage', () => {
      const states = stageStates(
        [
          proposal('survey', 'accepted', t(1), t(1)),
          { ...proposal('survey', 'accepted', t(2), t(3)), acceptedChanges: null },
        ],
        [],
      );
      expect(states[0]).toMatchObject({ completedAt: t(3) });
    });
  });
});

describe('worker-shaped change dumps (mirrors worker/tests/test_draft_stages.py)', () => {
  const dumps = [
    { op: 'putField', field: { id: 'sender', description: 'Who wrote it' }, reason: 'r' },
    { op: 'putTable', table: { id: 'items', columns: [{ id: 'name' }] }, reason: 'r' },
    {
      op: 'putStep',
      step: {
        type: 'extract',
        id: 'head',
        fields: ['sender'],
        sections: ['all'],
        instructions: 'Top of page 1',
      },
      reason: 'r',
    },
    {
      op: 'putStep',
      step: {
        type: 'extract',
        id: 'tail',
        fields: ['ref'],
        sections: ['all'],
        context: { who: 'sender' },
      },
      reason: 'r',
    },
    {
      op: 'putStep',
      step: { type: 'check', id: 'same', values: 'ref', reference: 'sender' },
      reason: 'r',
    },
    { op: 'setPreamble', preamble: 'Letters to QA.', reason: 'r' },
    {
      op: 'putSection',
      section: { id: 'approval', anchor: '^PROTOCOL APPROVAL', description: 'Signatures' },
      reason: 'r',
    },
    { op: 'putSection', section: { id: 'tail', anchor: '^END', required: false }, reason: 'r' },
    { op: 'removeSection', id: 'all', reason: 'r' },
    { op: 'setCopies', copies: { anchor: '^PROTOCOL$', select: 'first' }, reason: 'r' },
    { op: 'setCopies', copies: { anchor: '^PROTOCOL$' }, reason: 'r' },
    { op: 'setCopies', copies: null, reason: 'r' },
  ];
  it.each(dumps.map((d) => [d.op, d] as const))('%s parses', (_op, dump) => {
    expect(DraftChangeSchema.safeParse(dump).success).toBe(true);
  });

  it('a sections body with the worker anchorCheck grid parses', () => {
    const row = (id: string, line: string) => ({
      sampleId: id,
      firstPage: 1,
      pageCount: 1,
      error: null,
      missingRequired: ['b'],
      sections: [
        { id: 'a', found: true, page: 1, line, chars: 10 },
        { id: 'b', found: false, page: null, line: null, chars: 0 },
      ],
    });
    const body = {
      notes: '',
      changes: [{ op: 'putSection', section: { id: 'a', anchor: '^PROTOCOL' }, reason: 'r' }],
      anchorCheck: {
        anchorErrors: { c: 'missing ), unterminated subpattern at position 0' },
        samples: [row('s1', 'PROTOCOL X'), row('s2', 'PROTOCOL Y')],
      },
    };
    expect(parseChangeBody('sections', body)).not.toBeNull();
  });

  it('a mixed revise body from the worker converter parses', () => {
    const body = {
      notes: '',
      changes: [
        { op: 'putField', field: { id: 'ref', description: 'Reference' }, reason: 'r' },
        {
          op: 'putStep',
          step: { id: 'tail', type: 'extract', fields: ['ref'], sections: ['all'] },
          reason: 'r',
        },
        { op: 'putSection', section: { id: 'approval', anchor: '^APPROVAL' }, reason: 'r' },
      ],
    };
    expect(parseChangeBody('revise', body)?.changes).toHaveLength(3);
  });
});

describe('references stage', () => {
  const done = (stage: StageView['stage'], at: string): StageView => ({
    stage,
    state: 'accepted',
    completedAt: at,
    skippedAt: null,
  });
  const earlier = [
    done('survey', '2026-10-12T10:00:01.000Z'),
    done('outputs', '2026-10-12T10:00:02.000Z'),
    done('sections', '2026-10-12T10:00:03.000Z'),
    done('steps', '2026-10-12T10:00:04.000Z'),
  ];
  const base = {
    devSamples: 2,
    verified: 0,
    lastVerifiedAt: null,
    running: false,
    hasRuns: false,
    skippedAt: null,
  };

  it('needs every earlier stage complete', () => {
    expect(firstIncomplete(earlier)).toBeNull();
    expect(
      firstIncomplete([
        ...earlier.slice(0, 3),
        { stage: 'steps', state: 'pending', completedAt: null, skippedAt: null },
      ]),
    ).toBe('steps');
  });

  it('is accepted when every dev sample is verified, whatever earlier stages do later', () => {
    expect(referencesStage(base)).toEqual({
      stage: 'references',
      state: 'pending',
      completedAt: null,
      skippedAt: null,
    });
    expect(referencesStage({ ...base, hasRuns: true, running: true }).state).toBe('running');
    expect(
      referencesStage({
        ...base,
        hasRuns: true,
        verified: 1,
        lastVerifiedAt: '2026-10-12T10:00:05.000Z',
      }).state,
    ).toBe('proposed');
    const complete = { ...base, verified: 2, lastVerifiedAt: '2026-10-12T10:00:05.000Z' };
    expect(referencesStage(complete)).toEqual({
      stage: 'references',
      state: 'accepted',
      completedAt: '2026-10-12T10:00:05.000Z',
      skippedAt: null,
    });
    // A reference holds the outputs' true values: sections or steps changing later do not make it
    // wrong. An outputs change that does outdates the reference itself (fewer verified).
    expect(referencesStage(complete).state).toBe('accepted');
  });

  it('can be skipped', () => {
    expect(referencesStage({ ...base, skippedAt: '2026-10-12T10:00:06.000Z' })).toEqual({
      stage: 'references',
      state: 'skipped',
      completedAt: '2026-10-12T10:00:06.000Z',
      skippedAt: '2026-10-12T10:00:06.000Z',
    });
  });
});

describe('revise stage', () => {
  it('accepts every op and never blocks or is blocked', () => {
    const body = {
      notes: '',
      changes: [
        { op: 'putField', field: { id: 'a', type: 'text' }, reason: 'r' },
        { op: 'removeSection', id: 'sig', reason: 'r' },
        { op: 'setPreamble', preamble: 'x', reason: 'r' },
      ],
    };
    expect(parseChangeBody('revise', body)?.changes).toHaveLength(3);
    expect(blockingStage(stageStates([], []), 'revise')).toBeNull();
    expect(stageStates([], []).map((s) => s.stage)).not.toContain('revise');
  });
});

describe('answers (RV2)', () => {
  const field = { op: 'putField', field: { id: 'a', type: 'text' }, reason: 'r' };

  it('parses a revise change that names the feedback it answers, and an old one without', () => {
    expect(
      parseChangeBody('revise', { notes: '', changes: [{ ...field, answers: ['f1', 'f2'] }] })
        ?.changes[0],
    ).toMatchObject({ answers: ['f1', 'f2'] });
    expect(
      parseChangeBody('revise', { notes: '', changes: [field] })?.changes[0],
    ).not.toHaveProperty('answers');
  });

  it('only revise changes answer feedback', () => {
    expect(
      parseChangeBody('outputs', { notes: '', changes: [{ ...field, answers: ['f1'] }] }),
    ).toBeNull();
  });

  it('rejects an empty feedback id', () => {
    expect(
      parseChangeBody('revise', { notes: '', changes: [{ ...field, answers: [''] }] }),
    ).toBeNull();
  });
});

describe('answeredFeedback (RV2)', () => {
  const c = (answers?: string[]): DraftChange => ({
    op: 'removeStep',
    id: 's',
    reason: 'r',
    ...(answers ? { answers } : {}),
  });

  it.each<[string, DraftChange[], number[], string[], string[]]>([
    [
      'a proposal without answers resolves all it was sent',
      [c(), c()],
      [0],
      ['f1', 'f2'],
      ['f1', 'f2'],
    ],
    ['only the applied changes answer', [c(['f1']), c(['f2'])], [1], ['f1', 'f2'], ['f2']],
    ['a change may answer several', [c(['f1', 'f2'])], [0], ['f1', 'f2', 'f3'], ['f1', 'f2']],
    ['an id the proposal was not sent is ignored', [c(['f9', 'f1'])], [0], ['f1'], ['f1']],
    [
      'applied changes that answer nothing resolve nothing',
      [c(['f1']), c()],
      [1],
      ['f1', 'f2'],
      [],
    ],
    ['the order is the order sent', [c(['f2', 'f1'])], [0], ['f1', 'f2'], ['f1', 'f2']],
    ['an out-of-range index answers nothing', [c(['f1'])], [3], ['f1'], []],
  ])('%s', (_name, changes, applied, sent, expected) => {
    expect(answeredFeedback(changes, applied, sent)).toEqual(expected);
  });
});

describe('mappingStage (ADR 0011)', () => {
  const T = (n: number) => `2026-10-14T10:0${n}:00.000Z`;
  const accepted = (at: string, acceptedChanges: number[] = [0]) => ({
    stage: 'mapping' as const,
    status: 'accepted' as const,
    createdAt: at,
    decidedAt: at,
    acceptedChanges,
  });
  const base = {
    proposals: [],
    skips: [],
    confirms: [],
    outputsCompletedAt: T(0),
    briefChangedAt: T(0),
  };

  it.each<[string, Partial<Parameters<typeof mappingStage>[0]>, string, string | null]>([
    ['never run', {}, 'pending', null],
    ['accepted', { proposals: [accepted(T(2))] }, 'accepted', T(2)],
    [
      'running over an acceptance',
      {
        proposals: [
          accepted(T(2)),
          { stage: 'mapping', status: 'running', createdAt: T(3), decidedAt: null },
        ],
      },
      'running',
      T(2),
    ],
    [
      'stale after the outputs completed again',
      { proposals: [accepted(T(2))], outputsCompletedAt: T(4) },
      'stale',
      T(2),
    ],
    [
      'stale after the brief chose other ontologies',
      { proposals: [accepted(T(2))], briefChangedAt: T(5) },
      'stale',
      T(2),
    ],
    [
      'kept, so not stale',
      {
        proposals: [accepted(T(2))],
        outputsCompletedAt: T(4),
        confirms: [{ stage: 'mapping', confirmedAt: T(5), upTo: T(4) }],
      },
      'accepted',
      T(2),
    ],
    [
      'kept, then the outputs completed again',
      {
        proposals: [accepted(T(2))],
        outputsCompletedAt: T(6),
        confirms: [{ stage: 'mapping', confirmedAt: T(5), upTo: T(4) }],
      },
      'stale',
      T(2),
    ],
    [
      'an empty acceptance after one keeps it up to its time',
      { proposals: [accepted(T(2)), accepted(T(5), [])], outputsCompletedAt: T(4) },
      'accepted',
      T(2),
    ],
    ['skipped', { skips: [{ stage: 'mapping', skippedAt: T(3) }] }, 'skipped', T(3)],
  ])('%s', (_name, over, state, completedAt) => {
    const view = mappingStage({ ...base, ...over } as Parameters<typeof mappingStage>[0]);
    expect(view).toMatchObject({ stage: 'mapping', state, completedAt });
  });

  it('keeps up to the later of the outputs and the brief selection', () => {
    expect(mappingKeepUpTo(T(4), T(2))).toBe(T(4));
    expect(mappingKeepUpTo(null, T(2))).toBe(T(2));
    expect(mappingKeepUpTo(null, null)).toBeNull();
  });
});

describe('a worker-shaped mapping proposal (ADR 0011)', () => {
  it('parses as a mapping change body, and only for the mapping stage', () => {
    const body = {
      notes: 'Retrieval was lexical only for pharma v1: its terms are not embedded for emb/x yet.',
      changes: [
        {
          op: 'setDocumentMapping',
          document: { class: 'pharma:BatchRecord', iri: 'doc/{source}' },
          ontologies: [{ id: 'pharma', version: 1 }],
          prefixes: { pharma: 'https://ex.example/pharma#' },
          reason: 'r',
          confidence: 'high',
        },
        {
          op: 'putFieldMapping',
          field: 'lot',
          mapping: { property: 'pharma:batchNumber' },
          reason: 'r',
          confidence: 'medium',
          evidence: ['G17230211'],
          alternatives: [
            { iri: 'https://ex.example/pharma#productName', label: 'product name', score: 0.016 },
          ],
        },
        {
          op: 'putTableMapping',
          table: 'tests',
          mapping: {
            link: 'pharma:hasResult',
            class: 'pharma:TestResult',
            columns: { assay: { property: 'pharma:testName' } },
          },
          reason: 'r',
          confidence: 'low',
        },
        {
          op: 'putLocalTerm',
          term: { iri: 'https://l.example/x', kind: 'class', label: 'X' },
          reason: 'r',
          confidence: 'low',
        },
        { op: 'removeMapping', id: 'tests.ok', reason: 'r', confidence: 'high' },
      ],
    };
    expect(parseChangeBody('mapping', body)?.changes).toHaveLength(5);
    expect(parseChangeBody('outputs', body)).toBeNull();
  });
});

const progressFixture = JSON.parse(
  readFileSync(new URL('./fixtures/draft-progress.json', import.meta.url), 'utf8'),
) as Record<string, unknown[]>;

describe('drafting progress (issue #151)', () => {
  it.each(
    Object.entries(progressFixture).flatMap(([name, events]) =>
      events.map((e, i) => [`${name} ${i}`, e] as const),
    ),
  )("parses the worker's event %s", (_name, event) => {
    expect(DraftProgressSchema.parse(event)).toEqual(event);
  });

  it.each([
    ['an unknown phase', { phase: 'thinking' }],
    ['a zero attempt', { attempt: 0 }],
    ['a missing round', { round: undefined }],
  ])('refuses %s', (_name, over) => {
    const base = progressFixture.surveyRetried![1] as Record<string, unknown>;
    expect(DraftProgressSchema.safeParse({ ...base, ...over }).success).toBe(false);
  });

  it('is the event the worker writes', () => {
    expect(DRAFT_PROGRESS_EVENT).toBe('drafting progress');
  });
});
