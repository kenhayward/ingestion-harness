import type { ResultSummary } from '@ih/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ResultsPage } from '../src/results/ResultsPage.js';
import { timeOf } from '../src/results/format.js';
import { fakeApi } from './fake-api.js';

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
    expect(listResults).toHaveBeenLastCalledWith({ templateId: 'pvp', q: undefined });
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
    });
    await userEvent.click(within(show).getByRole('button', { name: 'Auto-approved' }));
    expect(listResults).toHaveBeenLastCalledWith({
      templateId: undefined,
      q: undefined,
      show: 'auto',
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
    expect(screen.getByText('3 results')).toBeInTheDocument();
  });

  it('filters by file name on the server, once typing pauses', async () => {
    const listResults = vi.fn(async () => [result()]);
    render(<ResultsPage api={fakeApi({ listResults })} />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter by file name' }), 'acme');
    await vi.waitFor(() =>
      expect(listResults).toHaveBeenLastCalledWith({ templateId: undefined, q: 'acme' }),
    );
    const qs = listResults.mock.calls.map((c) => (c as unknown as [{ q?: string }])[0].q);
    expect(qs).toEqual([undefined, 'acme']);
  });

  it('takes the top-bar search as the file name filter', async () => {
    const listResults = vi.fn(async () => [result()]);
    render(<ResultsPage api={fakeApi({ listResults })} query="acme" />);
    expect(screen.getByRole('searchbox', { name: 'Filter by file name' })).toHaveValue('acme');
    await vi.waitFor(() =>
      expect(listResults).toHaveBeenLastCalledWith({ templateId: undefined, q: 'acme' }),
    );
  });

  it('says when the filter matches nothing', async () => {
    const listResults = vi.fn(async (query?: { q?: string }) => (query?.q ? [] : [result()]));
    render(<ResultsPage api={fakeApi({ listResults })} query="zzz" />);
    expect(await screen.findByText('No results match “zzz”.')).toBeInTheDocument();
  });

  it('loads more with the last publish time as the cursor, keeping the filter', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) =>
      result({
        filename: `p1-${i}.pdf`,
        publishedAt: `2026-10-02T09:00:${String(59 - i).padStart(2, '0')}.000Z`,
      }),
    );
    const listResults = vi
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([result({ filename: 'p2.pdf' })]);
    render(<ResultsPage api={fakeApi({ listResults })} query="p" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(listResults).toHaveBeenLastCalledWith({
      templateId: undefined,
      q: 'p',
      before: page1[49]!.publishedAt,
      beforeId: page1[49]!.jobId,
    });
    expect(
      await screen.findByRole('button', { name: 'Show preview of p2.pdf' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show preview of p1-0.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
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

  it('disables Load more while a page is loading', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => result({ filename: `p1-${i}.pdf` }));
    let resolveMore!: (rows: ResultSummary[]) => void;
    const listResults = vi
      .fn()
      .mockResolvedValueOnce(page1)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveMore = resolve)));
    render(<ResultsPage api={fakeApi({ listResults })} />);
    const more = await screen.findByRole('button', { name: 'Load more' });
    await userEvent.click(more);
    expect(more).toBeDisabled();
    await userEvent.click(more);
    expect(listResults).toHaveBeenCalledTimes(2);
    await act(async () => resolveMore([result({ filename: 'p2.pdf' })]));
    expect(screen.getAllByRole('button', { name: 'Show preview of p2.pdf' })).toHaveLength(1);
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
