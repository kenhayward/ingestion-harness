import { describe, expect, it } from 'vitest';
import type { DraftChange, FeedbackItem, RunDiagnostics } from '@ih/shared';
import {
  answerNumbers,
  diagnosticLines,
  earlierRevisions,
  failureChips,
  failuresHeader,
  feedbackOrigin,
  feedbackTargetIds,
  notSentText,
  openProposalStage,
  previewSummary,
  revisionLine,
  sentFeedback,
  shownFeedback,
} from '../src/workbench/revise.js';
import {
  changeProposalView,
  feedbackItem,
  iterationView,
  MODEL_CHOICES,
  revisePreview,
  reviseProposal,
} from './fake-api.js';

const day = (iso: string) => new Date(iso).toLocaleDateString();

describe('feedbackTargetIds', () => {
  const def = {
    document: { sections: [{ id: 'header' }, { id: 'totals' }] },
    outputs: {
      fields: [{ id: 'total' }, { id: 'Bad Id' }],
      tables: [{ id: 'line_items' }],
    },
    pipeline: [
      { type: 'extract', id: 'head' },
      { type: 'check', id: 'sum' },
    ],
  };
  it.each([
    ['field', ['total']],
    ['table', ['line_items']],
    ['step', ['head', 'sum']],
    ['section', ['header', 'totals']],
  ] as const)('%s ids in definition order, only ids the API accepts', (target, ids) => {
    expect(feedbackTargetIds(def, target)).toEqual(ids);
  });
  it('is empty for a malformed definition', () => {
    expect(feedbackTargetIds(null, 'field')).toEqual([]);
  });
});

describe('failureChips', () => {
  it('names fields, shows actual ≠ expected for scalars, and counts rows and cells', () => {
    expect(
      failureChips({
        sample: 'a.pdf',
        score: 0.85,
        fields: [
          { id: 'due_date', expected: '2026-10-03', actual: null },
          { id: 'total', expected: '4,694.40', actual: '3,912.00' },
        ],
        tables: [
          { id: 'line_items', missing: 1, extra: 0, changed: [] },
          { id: 'fees', missing: 0, extra: 2, changed: [] },
          {
            id: 'lines',
            missing: 0,
            extra: 0,
            changed: [
              { expected: { qty: 1 }, actual: { qty: 2 }, columns: ['qty'] },
              {
                expected: { qty: 3, unit: 'x' },
                actual: { qty: 4, unit: 'y' },
                columns: ['qty', 'unit'],
              },
            ],
          },
        ],
      }),
    ).toEqual([
      'due_date',
      'total 3,912.00 ≠ 4,694.40',
      'line_items −1 row',
      'fees +2 rows',
      'lines.qty 2 cells',
      'lines.unit 1 cell',
    ]);
  });
});

describe('previewSummary / failuresHeader / notSentText', () => {
  const failure = { sample: 'a.pdf', score: 0.5, fields: [], tables: [] };
  it('summarises what is sent', () => {
    expect(
      previewSummary(
        revisePreview({
          feedback: [revisePreview().feedback[0]!],
          failures: [failure],
          failuresTotal: 1,
        }),
        MODEL_CHOICES,
      ),
    ).toBe(
      '1 feedback item · 1 failure diff (up to 20 fields and 5 rows per table each) · draft v4 · Main Production Model',
    );
  });
  it('says when the cap trims failures, and when there is no draft or model', () => {
    expect(
      previewSummary(
        revisePreview({
          feedback: [],
          failures: Array(8).fill(failure),
          failuresTotal: 11,
          draft: null,
          model: null,
        }),
        MODEL_CHOICES,
      ),
    ).toBe(
      '0 feedback items · 8 of 11 failure diffs (the worst 8; up to 20 fields and 5 rows per table each) · no open draft · drafting model not set',
    );
  });
  it('heads the failures with the run they come from', () => {
    const at = '2026-10-12T09:02:00.000Z';
    const from = {
      iterationId: crypto.randomUUID(),
      templateVersion: 4,
      model: null,
      createdAt: at,
      compared: 6,
    };
    expect(
      failuresHeader(revisePreview({ failuresFrom: from, failuresTotal: 6 }), MODEL_CHOICES),
    ).toBe(`v4 · ${day(at)} · 6 of 6 below 100%`);
    expect(
      failuresHeader(
        revisePreview({ failuresFrom: { ...from, model: 'cloud' }, failuresTotal: 2 }),
        MODEL_CHOICES,
      ),
    ).toBe(`v4 · ${day(at)} · 2 of 6 below 100% · Cloud model`);
    expect(failuresHeader(revisePreview(), MODEL_CHOICES)).toBeNull();
  });
  it.each([
    [
      { holdoutSamples: 2, holdoutRun: { iterationId: 'x', status: 'complete', score: 0.88 } },
      'Not sent: the holdout run (88%) and its 2 samples.',
    ],
    [
      { holdoutSamples: 1, holdoutRun: { iterationId: 'x', status: 'running', score: null } },
      'Not sent: the holdout run and its 1 sample.',
    ],
    [{ holdoutSamples: 3, holdoutRun: null }, 'Not sent: the 3 holdout samples.'],
    [{ holdoutSamples: 0, holdoutRun: null }, 'Not sent: holdout samples (none yet).'],
  ] as const)('%j', (notSent, text) => {
    expect(notSentText(notSent)).toBe(text);
  });
});

describe('feedbackOrigin', () => {
  const run = iterationView({
    id: crypto.randomUUID(),
    templateVersion: 4,
    createdAt: '2026-10-12T09:02:00.000Z',
  });
  it.each([
    [feedbackItem({ iterationId: run.id }), `From Evaluate · dev run v4 · ${day(run.createdAt)}`],
    [
      feedbackItem({ iterationId: crypto.randomUUID(), createdAt: '2026-10-11T17:20:00.000Z' }),
      `From Evaluate · ${day('2026-10-11T17:20:00.000Z')}`,
    ],
    [
      feedbackItem({ createdAt: '2026-10-11T17:20:00.000Z' }),
      `Added here · ${day('2026-10-11T17:20:00.000Z')}`,
    ],
  ])('%#', (item, text) => {
    expect(feedbackOrigin(item, [run])).toBe(text);
  });
});

describe('shownFeedback / answerNumbers', () => {
  const latest = reviseProposal();
  const open = feedbackItem({ body: 'open' });
  const answered = feedbackItem({ body: 'answered now', resolvedBy: latest.id });
  const old = feedbackItem({ body: 'answered before', resolvedBy: crypto.randomUUID() });
  it('shows open feedback and what the latest revision answered', () => {
    expect(shownFeedback([open, answered, old], latest).map((f) => f.body)).toEqual([
      'open',
      'answered now',
    ]);
    expect(shownFeedback([open, answered], null).map((f) => f.body)).toEqual(['open']);
  });
  it('numbers the answered feedback as listed, ignoring ids not shown', () => {
    const shown: FeedbackItem[] = [open, answered];
    const c: DraftChange = {
      op: 'removeStep',
      id: 's',
      reason: 'r',
      answers: [answered.id, 'gone', open.id],
    };
    expect(answerNumbers(c, shown)).toEqual([1, 2]);
    expect(answerNumbers({ op: 'removeStep', id: 's', reason: 'r' }, shown)).toEqual([]);
  });
});

describe('openProposalStage', () => {
  it('names the first drafting stage whose newest proposal waits for a decision', () => {
    expect(openProposalStage([changeProposalView({ stage: 'steps' })])).toBe('steps');
    expect(
      openProposalStage([
        changeProposalView({ stage: 'steps', status: 'accepted' }),
        changeProposalView({ stage: 'steps' }), // older one: superseded
      ]),
    ).toBeNull();
    expect(openProposalStage([reviseProposal()])).toBeNull(); // revise itself does not count
  });
});

describe('earlierRevisions / revisionLine', () => {
  it('lists the revisions before the latest with what they answered', () => {
    const older = reviseProposal({
      status: 'partially_accepted',
      acceptedChanges: [0],
      createdAt: '2026-10-10T08:00:00.000Z',
    });
    const rejected = reviseProposal({ status: 'rejected', createdAt: '2026-10-09T08:00:00.000Z' });
    const rows = earlierRevisions(
      [reviseProposal(), older, rejected],
      [feedbackItem({ resolvedBy: older.id })],
    );
    expect(rows.map((r) => revisionLine(r, MODEL_CHOICES))).toEqual([
      `${day(older.createdAt)} · Main Production Model · 1 of 2 applied · answered 1 feedback item`,
      `${day(rejected.createdAt)} · Main Production Model · rejected (2 changes)`,
    ]);
  });
});

describe('notSentText without ready holdout samples', () => {
  it('does not claim a count of samples after a run whose samples are gone', () => {
    const run = { iterationId: crypto.randomUUID(), status: 'complete' as const, score: 0.88 };
    expect(notSentText({ holdoutSamples: 0, holdoutRun: run })).toBe(
      'Not sent: the holdout run (88%).',
    );
    expect(notSentText({ holdoutSamples: 1, holdoutRun: { ...run, score: null } })).toBe(
      'Not sent: the holdout run and its 1 sample.',
    );
  });
});

describe('sentFeedback', () => {
  const sentItem = feedbackItem({ body: 'sent' });
  const held = feedbackItem({ body: 'held back' });
  const answered = feedbackItem({ body: 'answered', resolvedBy: crypto.randomUUID() });
  const preview = revisePreview({
    feedback: [{ ...revisePreview().feedback[0]!, id: sentItem.id }],
  });
  it('splits open feedback into what the preview sends and what it holds back', () => {
    const { sent, notSent } = sentFeedback([sentItem, held, answered], preview);
    expect(sent.map((f) => f.body)).toEqual(['sent', 'answered']);
    expect(notSent.map((f) => f.body)).toEqual(['held back']);
  });
});

describe('diagnosticLines', () => {
  const base: RunDiagnostics = {
    from: { draftVersion: 4, jobIds: ['j1'], at: '2026-10-12T09:00:00.000Z' },
    steps: [],
    columns: [],
    missedKeys: [],
  };
  it.each<[string, Partial<RunDiagnostics>, string[]]>([
    ['nothing', {}, []],
    [
      'a step with mostly empty calls',
      {
        steps: [
          { step: 'extract_table_8', sample: 'a.pdf', calls: 30, emptyCalls: 29, seconds: 169 },
        ],
      },
      ['extract_table_8 on a.pdf: 29 of 30 calls returned no rows (02:49)'],
    ],
    [
      'columns, one value and many',
      {
        columns: [
          {
            step: 's',
            target: 'assay',
            column: 'impurity_1_pct',
            issues: 3,
            examples: ['<0.05'],
            message: 'not a number',
            samples: ['a.pdf'],
          },
          {
            step: 's',
            target: 'assay',
            column: 'purity',
            issues: 1,
            examples: ['n/a'],
            message: 'not a number',
            samples: ['a.pdf'],
          },
          {
            step: 's',
            target: 'notes',
            column: null,
            issues: 2,
            examples: [],
            message: 'not a number',
            samples: ['a.pdf'],
          },
        ],
      },
      [
        'assay.impurity_1_pct: 3 values did not fit (e.g. <0.05)',
        'assay.purity: 1 value did not fit (e.g. n/a)',
        'notes: 2 values did not fit',
      ],
    ],
    [
      'missed headings',
      {
        missedKeys: [
          { sample: 'a.pdf', sections: ['s'], keys: ['1', '2', '3', '4'], total: 30 },
          { sample: 'b.pdf', sections: ['s'], keys: ['7', '8'], total: 2 },
        ],
      },
      ['a.pdf: headings 1, 2, 3 (+27) matched no anchor', 'b.pdf: headings 7, 8 matched no anchor'],
    ],
  ])('%s', (_name, part, lines) => {
    expect(diagnosticLines({ ...base, ...part })).toEqual(lines);
  });
});
