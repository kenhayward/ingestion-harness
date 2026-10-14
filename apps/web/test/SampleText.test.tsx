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

  it('shows every page in the Sections view (not paged)', async () => {
    render(<SampleText api={paged(3)} projectId="letter" sampleId="s1" />);
    for (const n of [1, 2, 3]) {
      expect(await screen.findByRole('region', { name: `Page ${n}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
  });
});

/** A sample of `count` pages; page 2 was read by OCR. */
function paged(count: number) {
  return fakeApi({
    getSampleText: vi.fn(async () => ({
      sha256: 'abc',
      pages: Array.from({ length: count }, (_, i) => ({
        number: i + 1,
        text: i === 0 ? 'intro\nHEADER' : `text of page ${i + 1}`,
        ocr: i === 1,
      })),
    })),
  });
}

describe('SampleText pager (Samples preview, paged)', () => {
  const pager = async () => within(await screen.findByRole('navigation', { name: 'Pages' }));
  const label = (p: ReturnType<typeof within>) => p.getByText(/^Page \d+$/).parentElement!;

  it('pages one at a time: Page n of N, previous and next', async () => {
    render(<SampleText api={paged(3)} projectId="letter" sampleId="s1" paged />);
    const p = await pager();
    const previous = p.getByRole('button', { name: 'Previous page' });
    const next = p.getByRole('button', { name: 'Next page' });
    expect(label(p)).toHaveTextContent('Page 1 of 3');
    expect(label(p)).toHaveAttribute('aria-live', 'polite');
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Page 1' })).toHaveTextContent('[page 1] intro');
    expect(screen.queryByRole('region', { name: 'Page 2' })).toBeNull();

    await userEvent.click(next);
    expect(label(p)).toHaveTextContent('Page 2 of 3');
    expect(previous).toBeEnabled();
    expect(next).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Page 2' })).toHaveTextContent('text of page 2');

    await userEvent.click(next);
    expect(label(p)).toHaveTextContent('Page 3 of 3');
    expect(next).toBeDisabled();

    await userEvent.click(previous);
    expect(label(p)).toHaveTextContent('Page 2 of 3');
  });

  it('has both buttons disabled for a one-page sample', async () => {
    render(<SampleText api={paged(1)} projectId="letter" sampleId="s1" paged />);
    const p = await pager();
    expect(label(p)).toHaveTextContent('Page 1 of 1');
    expect(p.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(p.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('tags only the pages read by OCR', async () => {
    render(<SampleText api={paged(3)} projectId="letter" sampleId="s1" paged />);
    const p = await pager();
    expect(p.queryByText('OCR')).toBeNull();
    await userEvent.click(p.getByRole('button', { name: 'Next page' }));
    expect(p.getByText('OCR')).toHaveAttribute('title', 'This page was read by OCR');
    await userEvent.click(p.getByRole('button', { name: 'Next page' }));
    expect(p.queryByText('OCR')).toBeNull();
  });

  it('turns pages with the arrow keys inside the text', async () => {
    render(<SampleText api={paged(3)} projectId="letter" sampleId="s1" paged />);
    const p = await pager();
    screen.getByRole('region', { name: 'Page 1' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(label(p)).toHaveTextContent('Page 2 of 3');
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(label(p)).toHaveTextContent('Page 3 of 3'); // stays on the last page
    await userEvent.keyboard('{ArrowLeft}');
    expect(label(p)).toHaveTextContent('Page 2 of 3');
  });

  it('still marks section starts on the shown page and scrolls to the focused one', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <SampleText
        api={paged(2)}
        projectId="letter"
        sampleId="s1"
        paged
        marks={[{ page: 1, line: 'HEADER', label: 'header' }]}
        focus="header"
      />,
    );
    const note = await screen.findByRole('note', { name: 'header starts here' });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts.at(-1)).toBe(note);
  });
});
