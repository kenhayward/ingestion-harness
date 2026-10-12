import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DraftChangeSchema,
  applyChanges,
  blockingStage,
  conflictingChanges,
  parseChangeBody,
  stableJson,
  stageStates,
  type DraftChange,
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
});
