import { describe, expect, it } from 'vitest';
import {
  BRIEF_SECTIONS,
  EMPTY_BRIEF,
  briefDiff,
  briefSectionText,
  briefVersions,
  type Brief,
  type BriefBody,
  type BriefSectionDiff,
  type BriefUse,
  type BriefVersionView,
} from '../src/index.js';

const body = (o: Partial<BriefBody> = {}): BriefBody => ({ ...EMPTY_BRIEF, ...o });
const brief = (version: number, o: Partial<BriefBody> = {}): Brief => ({
  projectId: 'letter',
  version,
  body: body(o),
  createdAt: `2026-10-0${version}T09:00:00.000Z`,
});
const use = (o: Partial<BriefUse> & Pick<BriefUse, 'stage'>): BriefUse => ({
  briefVersion: 1,
  decision: 'accepted',
  createdAt: '2026-10-05T09:00:00.000Z',
  ...o,
});

describe('briefDiff', () => {
  it.each<[string, BriefBody | null, BriefBody, BriefSectionDiff[]]>([
    ['identical', body({ purpose: 'a' }), body({ purpose: 'a' }), []],
    [
      'the first version against an empty brief',
      null,
      body({ purpose: 'Invoices', rules: 'DMY' }),
      [
        { section: 'purpose', before: '', after: 'Invoices' },
        { section: 'rules', before: '', after: 'DMY' },
      ],
    ],
    [
      'sections in the tab order, whatever the edit order',
      body({ rules: 'a', glossary: 'x' }),
      body({ rules: 'b', glossary: 'y', variants: 'v' }),
      [
        { section: 'glossary', before: 'x', after: 'y' },
        { section: 'variants', before: '', after: 'v' },
        { section: 'rules', before: 'a', after: 'b' },
      ],
    ],
    [
      'a cleared section',
      body({ exampleOutput: 'a,b\n1,2' }),
      body(),
      [{ section: 'exampleOutput', before: 'a,b\n1,2', after: '' }],
    ],
    [
      'answers as data, shown one per line',
      body({ answers: [{ question: 'Which copy?', answer: 'Executed' }] }),
      body({
        answers: [
          { question: 'Which copy?', answer: 'Executed' },
          { question: 'Dates?', answer: 'DMY' },
        ],
      }),
      [
        {
          section: 'answers',
          before: 'Which copy?: Executed',
          after: 'Which copy?: Executed\nDates?: DMY',
        },
      ],
    ],
    [
      'answers that read the same as text but differ as data',
      body({ answers: [{ question: 'a: b', answer: 'c' }] }),
      body({ answers: [{ question: 'a', answer: 'b: c' }] }),
      [{ section: 'answers', before: 'a: b: c', after: 'a: b: c' }],
    ],
  ])('%s', (_name, before, after, expected) => {
    expect(briefDiff(before, after)).toEqual(expected);
  });

  it('covers every brief field', () => {
    expect([...BRIEF_SECTIONS].sort()).toEqual(Object.keys(EMPTY_BRIEF).sort());
    expect(briefSectionText(body({ glossary: 'PO' }), 'glossary')).toBe('PO');
  });
});

describe('briefVersions', () => {
  const v1 = brief(1, { purpose: 'Letters' });
  const v2 = brief(2, { purpose: 'Letters', glossary: 'PO' });
  const v3 = brief(3, { purpose: 'Letters', glossary: 'PO', variants: 'two', rules: 'DMY' });

  it.each<
    [
      string,
      Brief[],
      BriefUse[],
      Pick<BriefVersionView, 'version' | 'changedSections' | 'usedBy'>[],
    ]
  >([
    ['no brief', [], [], []],
    [
      'newest first, each against its predecessor',
      [v1, v2, v3],
      [],
      [
        { version: 3, changedSections: ['variants', 'rules'], usedBy: [] },
        { version: 2, changedSections: ['glossary'], usedBy: [] },
        { version: 1, changedSections: ['purpose'], usedBy: [] },
      ],
    ],
    [
      'only applied proposals use a version',
      [v1, v2],
      [
        use({ stage: 'outputs', briefVersion: 2 }),
        use({ stage: 'sections', briefVersion: 2, decision: 'partially_accepted' }),
        use({ stage: 'steps', briefVersion: 2, decision: 'rejected' }),
        use({ stage: 'survey', briefVersion: 1, decision: null }),
      ],
      [
        { version: 2, changedSections: ['glossary'], usedBy: ['outputs', 'sections'] },
        { version: 1, changedSections: ['purpose'], usedBy: [] },
      ],
    ],
    [
      "a stage's newest applied proposal decides",
      [v1, v2],
      [
        use({ stage: 'outputs', briefVersion: 2, createdAt: '2026-10-06T09:00:00.000Z' }),
        use({ stage: 'outputs', briefVersion: 1, createdAt: '2026-10-05T09:00:00.000Z' }),
        use({ stage: 'survey', briefVersion: 1, createdAt: '2026-10-05T09:00:00.000Z' }),
        use({ stage: 'survey', briefVersion: null, createdAt: '2026-10-07T09:00:00.000Z' }),
      ],
      [
        { version: 2, changedSections: ['glossary'], usedBy: ['outputs'] },
        { version: 1, changedSections: ['purpose'], usedBy: [] },
      ],
    ],
    [
      'stages in drafting order',
      [v1],
      [use({ stage: 'revise' }), use({ stage: 'survey' }), use({ stage: 'steps' })],
      [{ version: 1, changedSections: ['purpose'], usedBy: ['survey', 'steps', 'revise'] }],
    ],
  ])('%s', (_name, briefs, proposals, expected) => {
    const views = briefVersions(briefs, proposals);
    expect(
      views.map(({ version, changedSections, usedBy }) => ({ version, changedSections, usedBy })),
    ).toEqual(expected);
    expect(views.map((v) => v.createdAt)).toEqual([...briefs].reverse().map((b) => b.createdAt));
  });

  it('sorts briefs given out of order', () => {
    expect(briefVersions([v2, v1], []).map((v) => v.version)).toEqual([2, 1]);
  });
});
