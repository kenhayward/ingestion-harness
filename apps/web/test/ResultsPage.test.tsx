import type { ResultSummary } from '@ih/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FALLBACK_PAGE_SIZE, ResultsPage } from '../src/results/ResultsPage.js';
import { timeOf } from '../src/results/format.js';
import { fakeApi } from './fake-api.js';
import { resultDetail } from './result-fixture.js';

const result = (o: Partial<ResultSummary> = {}): ResultSummary => ({
  jobId: crypto.randomUUID(),
  documentId: 'd',
  filename: 'a.pdf',
  contentType: 'application/pdf',
  specId: 'pvp',
  specVersion: 3,
  publishedAt: '2026-10-02T09:00:00.000Z',
  reviewer: null,
  reviewedAt: null,
  outputCount: 5,
  outputs: [],
  issueCount: 2,
  ...o,
});

const row = (file: string) =>
  screen.getByRole('button', { name: `Show preview of ${file}` }).closest('tr')!;
const preview = () => screen.getByRole('complementary', { name: 'Result preview' });
const types = [
  { id: 'pvp', version: 2, title: 'Process Validation Protocol' },
  { id: 'pvp', version: 3, title: 'Process Validation Protocol' },
  { id: 'invoice', version: 1, title: 'Invoice' },
];

describe('ResultsPage list', () => {
  it('lists document types with retired ones included, for the filter chips (M8)', async () => {
    const api = fakeApi();
    render(<ResultsPage api={api} />);
    await waitFor(() => expect(api.listSpecs).toHaveBeenCalledWith({ retired: 'include' }));
  });

  it('has a header and lists published documents', async () => {
    const r = result({
      filename: 'protocol.pdf',
      reviewer: 'Ken',
      reviewedAt: '2026-10-02T08:00:00Z',
    });
    const auto = result({ filename: 'auto.pdf', issueCount: null });
    const clean = result({ filename: 'clean.pdf', issueCount: 0 });
    const unnamed = result({ filename: 'unnamed.pdf', reviewedAt: '2026-10-02T08:00:00Z' });
    render(
      <ResultsPage api={fakeApi({ listResults: vi.fn(async () => [r, auto, clean, unnamed]) })} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Results' })).toBeInTheDocument();
    expect(
      screen.getByText(/Test runs and rejected documents never appear here\./),
    ).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Show preview of protocol.pdf' });
    expect(row('protocol.pdf')).toHaveTextContent('pvp v3');
    expect(within(row('protocol.pdf')).getByText('Ken')).toBeInTheDocument();
    expect(within(row('protocol.pdf')).getByText('2')).toBeInTheDocument();
    expect(within(row('auto.pdf')).getByText('Auto-approved')).toBeInTheDocument();
    expect(within(row('auto.pdf')).getByText('—')).toBeInTheDocument();
    expect(within(row('clean.pdf')).getByText('—')).toBeInTheDocument();
    expect(within(row('unnamed.pdf')).getByText('Unnamed reviewer')).toBeInTheDocument();
  });

  it('offers the full result, the PDF and one ZIP download in the preview', async () => {
    const r = result({
      jobId: 'j1',
      filename: 'a.pdf',
      outputs: [
        { outputId: 'document', format: 'json', name: 'document.json', rowCount: null },
        { outputId: 'results', format: 'csv', name: 'results.csv', rowCount: 3 },
      ],
    });
    render(<ResultsPage api={fakeApi({ listResults: vi.fn(async () => [r]) })} />);
    await screen.findByRole('button', { name: 'Show preview of a.pdf' });
    expect(within(row('a.pdf')).queryAllByRole('link')).toEqual([]);
    const actions = within(preview()).getByRole('group', { name: 'Actions' });
    const links = within(actions).getAllByRole('link');
    expect(links.map((l) => [l.getAttribute('aria-label'), l.getAttribute('href')])).toEqual([
      ['Open full result for a.pdf', '#/results/j1'],
      ['View PDF of a.pdf', '/api/jobs/j1/document'],
      ['Download a.pdf results as ZIP', '/api/results/j1/archive'],
    ]);
    expect(within(preview()).getByRole('link', { name: 'View PDF of a.pdf' })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('offers the viewer in the preview once it knows the result is a recipe one', async () => {
    const r = result({
      jobId: 'j2',
      filename: 'report.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    render(
      <ResultsPage
        api={fakeApi({
          listResults: vi.fn(async () => [r]),
          getResult: vi.fn(async () => resultDetail({ job: { ...resultDetail().job, id: 'j2' } })),
        })}
      />,
    );
    await screen.findByRole('button', { name: 'Show preview of report.docx' });
    const viewer = await within(preview()).findByRole('link', {
      name: 'Open report.docx in the viewer',
    });
    expect(viewer).toHaveAttribute('href', '#/review/j2');
    const actions = within(preview()).getByRole('group', { name: 'Actions' });
    expect(
      within(actions)
        .getAllByRole('link')
        .map((l) => l.getAttribute('aria-label')),
    ).toEqual([
      'Open full result for report.docx',
      'Open report.docx in the viewer',
      'Download original of report.docx',
      'Download report.docx results as ZIP',
    ]);
  });

  it('offers the original of a Word document as a download', async () => {
    const r = result({
      jobId: 'j2',
      filename: 'report.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    render(<ResultsPage api={fakeApi({ listResults: vi.fn(async () => [r]) })} />);
    await screen.findByRole('button', { name: 'Show preview of report.docx' });
    const link = within(preview()).getByRole('link', {
      name: 'Download original of report.docx',
    });
    expect(link).toHaveAttribute('href', '/api/jobs/j2/document');
    expect(link).toHaveAttribute('title', 'Download original (.docx)');
    expect(link).not.toHaveAttribute('target');
  });

  it('filters by document type with a select', async () => {
    const listResults = vi.fn(async () => [result()]);
    render(<ResultsPage api={fakeApi({ listResults, listSpecs: vi.fn(async () => types) })} />);
    const select = screen.getByRole('combobox', { name: 'Document type' });
    await within(select).findByRole('option', { name: 'Invoice' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All types', 'Invoice', 'Process Validation Protocol']);
    expect(select).toHaveValue('');
    await userEvent.selectOptions(select, 'Process Validation Protocol');
    expect(listResults).toHaveBeenLastCalledWith({ templateId: 'pvp', q: undefined, limit: 25 });
  });

  it('shows reviewed, auto-approved or with-issues results on the server', async () => {
    const listResults = vi.fn(async (query?: { show?: string }) =>
      query?.show === 'issues' ? [] : [result()],
    );
    render(<ResultsPage api={fakeApi({ listResults })} />);
    const show = screen.getByRole('group', { name: 'Show' });
    expect(
      within(show)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All', 'Reviewed', 'Auto-approved', 'With issues']);
    expect(within(show).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(show).getByRole('button', { name: 'Reviewed' }));
    expect(listResults).toHaveBeenLastCalledWith({
      templateId: undefined,
      q: undefined,
      show: 'reviewed',
      limit: 25,
    });
    await userEvent.click(within(show).getByRole('button', { name: 'Auto-approved' }));
    expect(listResults).toHaveBeenLastCalledWith({
      templateId: undefined,
      q: undefined,
      show: 'auto',
      limit: 25,
    });
    await userEvent.click(within(show).getByRole('button', { name: 'With issues' }));
    expect(within(show).getByRole('button', { name: 'With issues' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await screen.findByText('No published results with issues.')).toBeInTheDocument();
  });

  it('groups the rows by the day they were published, newest first, with the time', async () => {
    const now = Date.parse('2026-10-16T15:00:00');
    const rows = [
      result({ filename: 'today.pdf', publishedAt: new Date('2026-10-16T14:18:00').toISOString() }),
      result({
        filename: 'yesterday.pdf',
        publishedAt: new Date('2026-10-15T09:05:00').toISOString(),
      }),
      result({ filename: 'older.pdf', publishedAt: new Date('2026-10-12T08:57:00').toISOString() }),
    ];
    render(<ResultsPage api={fakeApi({ listResults: vi.fn(async () => rows) })} now={now} />);
    await screen.findByRole('button', { name: 'Show preview of today.pdf' });
    const days = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(days).toEqual(['Today', 'Yesterday', expect.stringMatching(/12 Oct|Oct 12/)]);
    expect(row('today.pdf')).toHaveTextContent(timeOf(rows[0]!.publishedAt));
    expect(screen.getByText('Showing 1–3 · newest first')).toBeInTheDocument();
  });

  it('filters by file name on the server, once typing pauses', async () => {
    const listResults = vi.fn(async () => [result()]);
    render(<ResultsPage api={fakeApi({ listResults })} />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter by file name' }), 'acme');
    await vi.waitFor(() =>
      expect(listResults).toHaveBeenLastCalledWith({ templateId: undefined, q: 'acme', limit: 25 }),
    );
    const qs = listResults.mock.calls.map((c) => (c as unknown as [{ q?: string }])[0].q);
    expect(qs).toEqual([undefined, 'acme']);
  });

  it('takes the top-bar search as the file name filter', async () => {
    const listResults = vi.fn(async () => [result()]);
    render(<ResultsPage api={fakeApi({ listResults })} query="acme" />);
    expect(screen.getByRole('searchbox', { name: 'Filter by file name' })).toHaveValue('acme');
    await vi.waitFor(() =>
      expect(listResults).toHaveBeenLastCalledWith({ templateId: undefined, q: 'acme', limit: 25 }),
    );
  });

  it('says when the filter matches nothing', async () => {
    const listResults = vi.fn(async (query?: { q?: string }) => (query?.q ? [] : [result()]));
    render(<ResultsPage api={fakeApi({ listResults })} query="zzz" />);
    expect(await screen.findByText('No results match “zzz”.')).toBeInTheDocument();
  });

  it('explains the empty state and shows load errors', async () => {
    const { unmount } = render(<ResultsPage api={fakeApi()} />);
    expect(await screen.findByText(/No published results yet/)).toBeInTheDocument();
    unmount();
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    render(<ResultsPage api={fakeApi({ listResults: failing })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load results: boom');
  });

  it('shows only the latest filter results when responses arrive out of order', async () => {
    let resolveAll!: (rows: ResultSummary[]) => void;
    let resolvePvp!: (rows: ResultSummary[]) => void;
    const listResults = vi.fn(
      (query?: { templateId?: string }) =>
        new Promise<ResultSummary[]>((resolve) => {
          if (query?.templateId === 'pvp') resolvePvp = resolve;
          else resolveAll = resolve;
        }),
    );
    render(<ResultsPage api={fakeApi({ listResults, listSpecs: vi.fn(async () => types) })} />);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Document type' }),
      await screen.findByRole('option', { name: 'Process Validation Protocol' }),
    );
    await act(async () => resolvePvp([result({ filename: 'pvp.pdf' })]));
    await act(async () => resolveAll([result({ filename: 'stale-all.pdf' })]));
    expect(screen.getByRole('button', { name: 'Show preview of pvp.pdf' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Show preview of stale-all.pdf' }),
    ).not.toBeInTheDocument();
  });

  it('says when the selected document type has no results', async () => {
    const listResults = vi.fn(async (query?: { templateId?: string }) =>
      query?.templateId ? [] : [result()],
    );
    render(<ResultsPage api={fakeApi({ listResults, listSpecs: vi.fn(async () => types) })} />);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Document type' }),
      await screen.findByRole('option', { name: 'Invoice' }),
    );
    expect(
      await screen.findByText('No published results for this document type.'),
    ).toBeInTheDocument();
  });
});

describe('ResultsPage while a filter loads', () => {
  it('keeps the current rows (no false empty state) until the filtered page arrives', async () => {
    let resolveFiltered!: (rows: ResultSummary[]) => void;
    const listResults = vi.fn((query?: { q?: string }) =>
      query?.q
        ? new Promise<ResultSummary[]>((resolve) => (resolveFiltered = resolve))
        : Promise.resolve([result({ filename: 'a.pdf' })]),
    );
    render(<ResultsPage api={fakeApi({ listResults })} />);
    await screen.findByRole('button', { name: 'Show preview of a.pdf' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter by file name' }), 'acme');
    await vi.waitFor(() => expect(listResults).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/No results match/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show preview of a.pdf' })).toBeInTheDocument();
    await act(async () => resolveFiltered([result({ filename: 'acme.pdf' })]));
    expect(screen.getByRole('button', { name: 'Show preview of acme.pdf' })).toBeInTheDocument();
  });

  it('limits the file name filter to 100 characters', () => {
    render(<ResultsPage api={fakeApi()} />);
    expect(screen.getByRole('searchbox', { name: 'Filter by file name' })).toHaveAttribute(
      'maxLength',
      '100',
    );
  });
});

describe('ResultsPage help', () => {
  it('explains the Results page from the page header', async () => {
    render(<ResultsPage api={fakeApi()} />);
    const header = screen
      .getByRole('heading', { level: 1, name: 'Results' })
      .closest('.page-header')!;
    await userEvent.click(
      within(header as HTMLElement).getByRole('button', { name: 'Help: Using the Results page' }),
    );
    expect(screen.getByRole('dialog', { name: 'Using the Results page' })).toBeInTheDocument();
  });
});

/** `n` results of one day, newest first: r-01.pdf … */
const oneDay = (n: number, day = '2026-10-02') =>
  Array.from({ length: n }, (_, i) =>
    result({
      filename: `r-${String(i + 1).padStart(2, '0')}.pdf`,
      publishedAt: `${day}T09:${String(59 - i).padStart(2, '0')}:00.000Z`,
    }),
  );
const shownFiles = () =>
  screen.getAllByRole('button', { name: /^Show preview of / }).map((b) => b.textContent);
const pager = () => screen.getByRole('navigation', { name: 'Pages of results' });

describe('ResultsPage pages', () => {
  it('asks for a page of results as large as the list holds, day headings counted', async () => {
    expect(FALLBACK_PAGE_SIZE).toBe(25);
    const rows = oneDay(30);
    const listResults = vi.fn(async (q?: { limit?: number }) => rows.slice(0, q?.limit));
    render(<ResultsPage api={fakeApi({ listResults })} />);
    await screen.findByRole('button', { name: 'Show preview of r-01.pdf' });
    expect(listResults).toHaveBeenLastCalledWith({
      templateId: undefined,
      q: undefined,
      limit: 25,
    });
    // 25 lines: the day heading and 24 results.
    expect(shownFiles()).toHaveLength(24);
    expect(screen.getAllByRole('rowheader')).toHaveLength(1);
    expect(screen.getByText('Showing 1–24 · newest first')).toBeInTheDocument();
    expect(pager()).toHaveTextContent('Page 1');
    expect(within(pager()).getByRole('button', { name: 'Newer results' })).toBeDisabled();
    expect(within(pager()).getByRole('button', { name: 'Older results' })).toBeEnabled();
  });

  it('pages older from the last result shown, and back newer, keeping the filter', async () => {
    const rows = oneDay(30);
    const listResults = vi.fn(async (q?: { limit?: number; beforeId?: string }) => {
      const from = q?.beforeId ? rows.findIndex((r) => r.jobId === q.beforeId) + 1 : 0;
      return rows.slice(from, from + (q?.limit ?? 50));
    });
    render(<ResultsPage api={fakeApi({ listResults })} query="r" />);
    await screen.findByRole('button', { name: 'Show preview of r-01.pdf' });
    await userEvent.click(within(pager()).getByRole('button', { name: 'Older results' }));
    expect(listResults).toHaveBeenLastCalledWith({
      templateId: undefined,
      q: 'r',
      limit: 25,
      before: rows[23]!.publishedAt,
      beforeId: rows[23]!.jobId,
    });
    expect(
      await screen.findByRole('button', { name: 'Show preview of r-25.pdf' }),
    ).toBeInTheDocument();
    expect(shownFiles()).toEqual([
      'r-25.pdf',
      'r-26.pdf',
      'r-27.pdf',
      'r-28.pdf',
      'r-29.pdf',
      'r-30.pdf',
    ]);
    // The page starts inside the day: its heading says so.
    expect(screen.getByRole('rowheader')).toHaveTextContent('(continued)');
    expect(screen.getByText('Showing 25–30 · newest first')).toBeInTheDocument();
    expect(pager()).toHaveTextContent('Page 2');
    expect(within(pager()).getByRole('button', { name: 'Older results' })).toBeDisabled();
    await userEvent.click(within(pager()).getByRole('button', { name: 'Newer results' }));
    expect(
      await screen.findByRole('button', { name: 'Show preview of r-01.pdf' }),
    ).toBeInTheDocument();
    expect(listResults).toHaveBeenLastCalledWith({ templateId: undefined, q: 'r', limit: 25 });
    expect(pager()).toHaveTextContent('Page 1');
  });

  it('goes back to the first page when a filter changes', async () => {
    const rows = oneDay(30);
    const listResults = vi.fn(async (q?: { limit?: number; beforeId?: string }) => {
      const from = q?.beforeId ? rows.findIndex((r) => r.jobId === q.beforeId) + 1 : 0;
      return rows.slice(from, from + (q?.limit ?? 50));
    });
    render(<ResultsPage api={fakeApi({ listResults })} />);
    await screen.findByRole('button', { name: 'Show preview of r-01.pdf' });
    await userEvent.click(within(pager()).getByRole('button', { name: 'Older results' }));
    await screen.findByRole('button', { name: 'Show preview of r-25.pdf' });
    await userEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    expect(listResults).toHaveBeenLastCalledWith({
      templateId: undefined,
      q: undefined,
      show: 'reviewed',
      limit: 25,
    });
    expect(
      await screen.findByRole('button', { name: 'Show preview of r-01.pdf' }),
    ).toBeInTheDocument();
    expect(pager()).toHaveTextContent('Page 1');
  });
});

describe('ResultsPage keyboard', () => {
  const paged = () => {
    const rows = oneDay(30);
    return vi.fn(async (q?: { limit?: number; beforeId?: string }) => {
      const from = q?.beforeId ? rows.findIndex((r) => r.jobId === q.beforeId) + 1 : 0;
      return rows.slice(from, from + (q?.limit ?? 50));
    });
  };

  it('moves the selection with ↑ and ↓, onto the next page and back', async () => {
    render(<ResultsPage api={fakeApi({ listResults: paged() })} />);
    (await screen.findByRole('button', { name: 'Show preview of r-23.pdf' })).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Show preview of r-24.pdf' })).toHaveFocus();
    expect(within(preview()).getByRole('heading', { name: 'r-24.pdf' })).toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Show preview of r-25.pdf' })).toHaveFocus(),
    );
    expect(pager()).toHaveTextContent('Page 2');
    await userEvent.keyboard('{ArrowUp}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Show preview of r-24.pdf' })).toHaveFocus(),
    );
    expect(pager()).toHaveTextContent('Page 1');
  });

  it('pages with Page Down and Page Up, selecting the first result of the page', async () => {
    render(<ResultsPage api={fakeApi({ listResults: paged() })} />);
    (await screen.findByRole('button', { name: 'Show preview of r-03.pdf' })).focus();
    await userEvent.keyboard('{PageDown}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Show preview of r-25.pdf' })).toHaveFocus(),
    );
    await userEvent.keyboard('{PageUp}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Show preview of r-01.pdf' })).toHaveFocus(),
    );
  });

  it('opens the selected result with Enter', async () => {
    const rows = [result({ jobId: '11111111-1111-4111-8111-111111111111', filename: 'a.pdf' })];
    render(<ResultsPage api={fakeApi({ listResults: vi.fn(async () => rows) })} />);
    window.location.hash = '#/results';
    (await screen.findByRole('button', { name: 'Show preview of a.pdf' })).focus();
    await userEvent.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/results/11111111-1111-4111-8111-111111111111');
    window.location.hash = '';
  });

  it('says how to move with the keyboard', async () => {
    render(<ResultsPage api={fakeApi({ listResults: vi.fn(async () => [result()]) })} />);
    await screen.findByRole('button', { name: 'Show preview of a.pdf' });
    expect(screen.getByText(/select ·/)).toBeInTheDocument();
  });
});
