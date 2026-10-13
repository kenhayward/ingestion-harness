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
    expect(screen.getByRole('button', { name: 'a.pdf · totals' })).toHaveTextContent('missing');
    expect(within(table).getByRole('row', { name: /b\.pdf/ })).toHaveTextContent('not prepared');
    expect(within(table).getByRole('row', { name: /b\.pdf/ })).toHaveTextContent('holdout');
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
      /missing \(required\)/,
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
});
