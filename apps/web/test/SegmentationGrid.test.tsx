import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SegmentationResult } from '@ih/shared';
import { SegmentationGrid } from '../src/workbench/SegmentationGrid.js';
import { sampleView } from './fake-api.js';

const a = sampleView({ id: 's1', filename: 'a.pdf' });
const b = sampleView({ id: 's2', filename: 'b.pdf', role: 'holdout' });
const result: SegmentationResult = {
  anchorErrors: { totals: 'missing ), unterminated subpattern at position 0' },
  suggestions: [],
  samples: [
    {
      sampleId: 's1',
      firstPage: 1,
      pageCount: 3,
      error: null,
      missingRequired: ['totals'],
      sections: [
        { id: 'header', found: true, page: 1, line: 'INVOICE 42', chars: 120 },
        { id: 'totals', found: false, page: null, line: null, chars: 0 },
      ],
    },
    {
      sampleId: 's2',
      firstPage: 1,
      pageCount: 0,
      error: 'not prepared',
      missingRequired: [],
      sections: [],
    },
  ],
};
const sections = [
  { id: 'header', required: true },
  { id: 'totals', required: true },
];

describe('SegmentationGrid', () => {
  it('shows each sample × section with page and size, hits per section, and anchor errors', () => {
    render(
      <SegmentationGrid result={result} sections={sections} samples={[a, b]} onOpen={vi.fn()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'totals: missing ), unterminated subpattern',
    );
    const table = screen.getByRole('table', { name: 'Section anchors' });
    expect(
      within(table).getByRole('columnheader', { name: /header, matched in 1 of 1 samples/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'a.pdf · header' })).toHaveTextContent('p.1 · 120');
    expect(screen.getByRole('button', { name: 'a.pdf · totals' })).toHaveTextContent(
      'Missing (required)',
    );
    expect(within(table).getByRole('row', { name: /b\.pdf/ })).toHaveTextContent('not prepared');
    expect(within(table).getByRole('row', { name: /b\.pdf/ })).toHaveTextContent('HOLDOUT');
  });

  it('says when an anchor matches more than once (a repeated block)', () => {
    const repeated: SegmentationResult = {
      ...result,
      anchorErrors: {},
      samples: [
        {
          ...result.samples[0]!,
          missingRequired: [],
          sections: [
            { id: 'header', found: true, page: 1, line: 'INVOICE 42', chars: 120, matches: 3 },
            { id: 'totals', found: true, page: 2, line: 'Total', chars: 100, matches: 1 },
          ],
        },
      ],
    };
    render(
      <SegmentationGrid result={repeated} sections={sections} samples={[a]} onOpen={vi.fn()} />,
    );
    const header = screen.getByRole('button', { name: 'a.pdf · header' });
    expect(header).toHaveTextContent('matches 3×');
    expect(header).toHaveAccessibleDescription(/only the first starts the section/);
    expect(screen.getByRole('button', { name: 'a.pdf · totals' })).not.toHaveTextContent('matches');
  });

  it('opens a cell', async () => {
    const onOpen = vi.fn();
    render(
      <SegmentationGrid result={result} sections={sections} samples={[a, b]} onOpen={onOpen} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'a.pdf · header' }));
    expect(onOpen).toHaveBeenCalledWith('s1', 'header');
  });

  it('describes each cell to assistive technology with its size and flag', () => {
    render(
      <SegmentationGrid result={result} sections={sections} samples={[a, b]} onOpen={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'a.pdf · totals' })).toHaveAccessibleDescription(
      /Missing \(required\)/,
    );
    expect(screen.getByRole('button', { name: 'a.pdf · header' })).toHaveAccessibleDescription(
      /p\.1 · 120/,
    );
  });

  it('marks a section the preview has no data for as not in preview yet', () => {
    const withNotes = [...sections, { id: 'notes', required: true }];
    render(
      <SegmentationGrid result={result} sections={withNotes} samples={[a, b]} onOpen={vi.fn()} />,
    );
    const button = screen.getByRole('button', { name: 'a.pdf · notes' });
    expect(button).toHaveAccessibleDescription('not in preview yet');
    expect(button.closest('td')?.className ?? '').not.toMatch(/cell-/);
  });

  it('marks the selected cell, lists the states and flags a section that swallows the text', () => {
    const swallowing: SegmentationResult = {
      anchorErrors: {},
      suggestions: [],
      samples: [
        {
          ...result.samples[0]!,
          missingRequired: [],
          sections: [
            { id: 'header', found: true, page: 1, line: 'INVOICE 42', chars: 80 },
            { id: 'totals', found: true, page: 2, line: 'Total', chars: 920 },
          ],
        },
      ],
    };
    render(
      <SegmentationGrid
        result={swallowing}
        sections={sections}
        samples={[a]}
        selected={{ sampleId: 's1', sectionId: 'totals' }}
        onOpen={vi.fn()}
      />,
    );
    const totals = screen.getByRole('button', { name: 'a.pdf · totals' });
    expect(totals).toHaveAttribute('aria-pressed', 'true');
    expect(totals).toHaveTextContent('92% of text');
    expect(totals).toHaveAccessibleDescription(/swallows more than 60% of the text/);
    expect(screen.getByRole('button', { name: 'a.pdf · header' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    const legend = screen.getByRole('list', { name: 'Cell states' });
    expect(legend).toHaveTextContent('Found');
    expect(legend).toHaveTextContent('Swallows > 60% of the text');
    expect(legend).toHaveTextContent('Missing (required)');
    expect(legend).toHaveTextContent('Missing (optional)');
  });

  it('keeps one column and unique DOM ids when section ids are empty or repeated', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const repeated = [
      { id: 'header', required: true },
      { id: '', required: true },
      { id: 'header', required: true },
      { id: '', required: false },
    ];
    const { container } = render(
      <SegmentationGrid result={result} sections={repeated} samples={[a, b]} onOpen={vi.fn()} />,
    );
    const ids = [...container.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(screen.getAllByRole('button', { name: 'a.pdf · header' })).toHaveLength(1);
    expect(screen.getAllByRole('columnheader')).toHaveLength(2); // Sample + header
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it('shows a section the preview has not seen as pending, not as 0 hits', () => {
    const renamed = [
      { id: 'header', required: true },
      { id: 'totalz', required: true },
    ];
    render(
      <SegmentationGrid result={result} sections={renamed} samples={[a, b]} onOpen={vi.fn()} />,
    );
    const head = screen.getByRole('columnheader', { name: /totalz/ });
    expect(head).toHaveAccessibleName('totalz, not in the preview yet');
    expect(head.querySelector('.tone-text-danger')).toBeNull();
  });
});

describe('SegmentationGrid with repeating sections', () => {
  const occ = (page: number, key: string | null, keySource: 'own' | 'inherited' | null) => ({
    page,
    line: `Table ${page}`,
    chars: 20,
    key,
    keySource,
  });
  const repeated: SegmentationResult = {
    anchorErrors: {},
    suggestions: [],
    samples: [
      {
        sampleId: 's1',
        firstPage: 1,
        pageCount: 4,
        error: null,
        missingRequired: [],
        keyIssues: ['microbial: no occurrence for batch 4586785'],
        sections: [
          {
            id: 'appearance',
            found: true,
            page: 2,
            line: 'Table 1',
            chars: 60,
            matches: 0,
            occurrences: [
              occ(2, '4586783', 'own'),
              occ(3, '4586784', 'inherited'),
              occ(4, '4586785', 'own'),
            ],
          },
        ],
      },
    ],
  };

  it('shows the occurrences with their keys, an inherited one marked', () => {
    render(
      <SegmentationGrid
        result={repeated}
        sections={[{ id: 'appearance', required: true, keyFrom: 'batch' }]}
        samples={[a]}
        onOpen={vi.fn()}
      />,
    );
    const cell = screen.getByRole('button', { name: 'a.pdf · appearance' });
    expect(cell).toHaveTextContent('×3 · 4586783 · 4586784 · 4586785');
    expect(cell).toHaveTextContent('4586784 from batch');
  });

  it('lists a sample’s key issues', () => {
    render(
      <SegmentationGrid
        result={repeated}
        sections={[{ id: 'appearance', required: true }]}
        samples={[a]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole('note', { name: 'Key issues in a.pdf' })).toHaveTextContent(
      'microbial: no occurrence for batch 4586785',
    );
  });

  it('notes the headings no anchor caught, with the first line, and nothing without any', () => {
    const missed: SegmentationResult = {
      anchorErrors: {},
      suggestions: [],
      samples: [
        {
          sampleId: 's1',
          firstPage: 1,
          pageCount: 2,
          error: null,
          missingRequired: [],
          missedKeys: [
            { sections: ['dissolution'], key: '4586785', line: 'Table 9: Batch 4586785' },
            { sections: ['dissolution'], key: '4586786', line: 'Table 10: Batch 4586786' },
          ],
          sections: [{ id: 'dissolution', found: true, page: 1, line: 'Table 1', chars: 50 }],
        },
        {
          sampleId: 's2',
          firstPage: 1,
          pageCount: 1,
          error: null,
          missingRequired: [],
          sections: [{ id: 'dissolution', found: true, page: 1, line: 'Table 1', chars: 50 }],
        },
      ],
    };
    render(
      <SegmentationGrid
        result={missed}
        sections={[{ id: 'dissolution', required: true }]}
        samples={[a, b]}
        onOpen={vi.fn()}
      />,
    );
    const note = screen.getByRole('note', { name: 'Missed headings in a.pdf' });
    expect(note.querySelector('p')?.textContent).toBe(
      'Missed headings: 4586785, 4586786 · dissolution',
    );
    expect(note).toHaveTextContent('dissolution');
    expect(note).toHaveTextContent('Table 9: Batch 4586785');
    expect(screen.queryByRole('note', { name: 'Missed headings in b.pdf' })).toBeNull();
  });

  it('names the sections of every missed-heading group, not only the first', () => {
    const missed: SegmentationResult = {
      anchorErrors: {},
      suggestions: [],
      samples: [
        {
          sampleId: 's1',
          firstPage: 1,
          pageCount: 2,
          error: null,
          missingRequired: [],
          missedKeys: [
            { sections: ['dissolution'], key: '7', line: 'Table 7: D' },
            { sections: ['assay'], key: '8', line: 'Table 8: A' },
            { sections: ['dissolution'], key: '9', line: 'Table 9: D' },
          ],
          sections: [
            { id: 'dissolution', found: true, page: 1, line: 'Table 1', chars: 50 },
            { id: 'assay', found: true, page: 1, line: 'Table 2', chars: 50 },
          ],
        },
      ],
    };
    render(
      <SegmentationGrid
        result={missed}
        sections={[
          { id: 'dissolution', required: true },
          { id: 'assay', required: true },
        ]}
        samples={[a]}
        onOpen={vi.fn()}
      />,
    );
    const note = screen.getByRole('note', { name: 'Missed headings in a.pdf' });
    expect(note.querySelector('p')?.textContent).toBe(
      'Missed headings: 7, 8, 9 · dissolutionassay',
    );
  });
});
