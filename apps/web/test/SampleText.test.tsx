import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SampleText, type TextMark } from '../src/workbench/SampleText.js';
import { fakeApi } from './fake-api.js';

function show(text: string, marks: TextMark[]) {
  const api = fakeApi({
    getSampleText: vi.fn(async () => ({
      sha256: 'abc',
      pages: [{ number: 1, text, ocr: false }],
    })),
  });
  render(<SampleText api={api} projectId="letter" sampleId="s1" marks={marks} />);
}

describe('SampleText marks', () => {
  it('colours a section start marker', async () => {
    show('intro\nHEADER\nbody', [
      { page: 1, line: 'HEADER', label: 'header', color: 'var(--ih-ok-fg)' },
    ]);
    const mark = await screen.findByRole('note', { name: 'header starts here' });
    expect(mark).toHaveStyle({ background: 'var(--ih-ok-fg)' });
    expect(mark).toHaveTextContent('▶ header starts here');
  });

  it('keeps a line’s leading spaces and scrolls long lines', async () => {
    show('intro\n        TEM-290\nend', [{ page: 1, line: 'TEM-290', label: 'item' }]);
    const note = await screen.findByRole('note', { name: 'item starts here' });
    const pre = note.closest('pre')!;
    expect(pre.textContent).toContain('\n        TEM-290\n');
    expect(pre).toHaveStyle({ whiteSpace: 'pre', overflowX: 'auto' });
  });

  it('scrolls the focused section start into view', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const api = fakeApi({
      getSampleText: vi.fn(async () => ({
        sha256: 'abc',
        pages: [{ number: 1, text: 'intro\nHEADER\nbody', ocr: false }],
      })),
    });
    render(
      <SampleText
        api={api}
        projectId="letter"
        sampleId="s1"
        marks={[{ page: 1, line: 'HEADER', label: 'header' }]}
        focus="header"
      />,
    );
    const note = await screen.findByRole('note', { name: 'header starts here' });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts.at(-1)).toBe(note);
  });

  it('keeps leading spaces in unmarked text too', async () => {
    show('intro\n        TEM-290\nend', []);
    const pre = (await screen.findByText(/TEM-290/)).closest('pre')!;
    expect(pre.textContent).toBe('intro\n        TEM-290\nend');
    expect(pre).toHaveStyle({ whiteSpace: 'pre', overflowX: 'auto' });
  });

  it('prefers an exact line match over an earlier line that merely starts with the mark', async () => {
    show('TOTALS carried\nbody\nTOTAL\nend', [{ page: 1, line: 'TOTAL', label: 'total' }]);
    const note = await screen.findByRole('note', { name: 'total starts here' });
    expect(note.parentElement).toHaveTextContent('TOTAL');
    expect(note.parentElement).not.toHaveTextContent('TOTALS');
  });

  it('falls back to a prefix match when no line equals the mark', async () => {
    show('intro\nTOTALS carried\nend', [{ page: 1, line: 'TOTAL', label: 'total' }]);
    const note = await screen.findByRole('note', { name: 'total starts here' });
    expect(note.parentElement).toHaveTextContent('TOTALS carried');
  });

  it('ignores a mark with an empty line', async () => {
    show('intro\n\nbody', [{ page: 1, line: '', label: 'blank' }]);
    await screen.findByText(/intro/);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows one page at a time with per-page chips in paged mode', async () => {
    const api = fakeApi({
      getSampleText: vi.fn(async () => ({
        sha256: 'abc',
        pages: [
          { number: 1, text: 'HEADER', ocr: false },
          { number: 2, text: 'scanned', ocr: true },
        ],
      })),
    });
    render(<SampleText api={api} projectId="letter" sampleId="s1" paged />);
    const chips = await screen.findByRole('group', { name: 'Pages' });
    expect(within(chips).getByRole('button', { name: 'Page 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('region', { name: 'Page 1' })).toHaveTextContent('[page 1] HEADER');
    expect(screen.queryByRole('region', { name: 'Page 2' })).toBeNull();
    await userEvent.click(within(chips).getByRole('button', { name: 'Page 2 OCR' }));
    expect(screen.getByRole('region', { name: 'Page 2' })).toHaveTextContent('[page 2] scanned');
  });
});
