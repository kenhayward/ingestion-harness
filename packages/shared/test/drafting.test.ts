import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DraftChangeSchema,
  applyChanges,
  blockingStage,
  conflictingChanges,
  firstIncomplete,
  parseChangeBody,
  referencesStage,
  stableJson,
  stageStates,
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

  it('is accepted when every dev sample is verified, and stale after a later earlier-stage change', () => {
    expect(referencesStage(earlier, base)).toEqual({
      stage: 'references',
      state: 'pending',
      completedAt: null,
      skippedAt: null,
    });
    expect(referencesStage(earlier, { ...base, hasRuns: true, running: true }).state).toBe(
      'running',
    );
    expect(
      referencesStage(earlier, {
        ...base,
        hasRuns: true,
        verified: 1,
        lastVerifiedAt: '2026-10-12T10:00:05.000Z',
      }).state,
    ).toBe('proposed');
    const complete = { ...base, verified: 2, lastVerifiedAt: '2026-10-12T10:00:05.000Z' };
    expect(referencesStage(earlier, complete)).toEqual({
      stage: 'references',
      state: 'accepted',
      completedAt: '2026-10-12T10:00:05.000Z',
      skippedAt: null,
    });
    const changedLater = [...earlier.slice(0, 3), done('steps', '2026-10-12T10:00:09.000Z')];
    expect(referencesStage(changedLater, complete).state).toBe('stale');
  });

  it('can be skipped', () => {
    expect(referencesStage(earlier, { ...base, skippedAt: '2026-10-12T10:00:06.000Z' })).toEqual({
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
