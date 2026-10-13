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
});
