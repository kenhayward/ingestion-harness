import type { ResultSummary } from '@ih/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ResultsPage } from '../src/results/ResultsPage.js';
import { fakeApi } from './fake-api.js';

const result = (o: Partial<ResultSummary> = {}): ResultSummary => ({
  jobId: crypto.randomUUID(),
  documentId: 'd',
  filename: 'a.pdf',
  specId: 'pvp',
  specVersion: 3,
  publishedAt: '2026-10-02T09:00:00.000Z',
  reviewer: null,
  reviewedAt: null,
  outputCount: 5,
  issueCount: 2,
  ...o,
});

describe('ResultsPage', () => {
  it('lists published documents with links to their results', async () => {
    const r = result({
      filename: 'protocol.pdf',
      reviewer: 'Ken',
      reviewedAt: '2026-10-02T08:00:00Z',
    });
    const auto = result({ filename: 'auto.pdf', issueCount: null });
    const unnamed = result({ filename: 'unnamed.pdf', reviewedAt: '2026-10-02T08:00:00Z' });
    render(<ResultsPage api={fakeApi({ listResults: vi.fn(async () => [r, auto, unnamed]) })} />);

    const link = await screen.findByRole('link', { name: 'protocol.pdf' });
    expect(link).toHaveAttribute('href', `#/results/${r.jobId}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText('pvp v3')).toBeInTheDocument();
    expect(within(row).getByText('Ken')).toBeInTheDocument();
    const autoRow = screen.getByRole('link', { name: 'auto.pdf' }).closest('tr')!;
    expect(within(autoRow).getByText('auto')).toBeInTheDocument();
    expect(within(autoRow).getByText('—')).toBeInTheDocument();
    const unnamedRow = screen.getByRole('link', { name: 'unnamed.pdf' }).closest('tr')!;
    expect(within(unnamedRow).getByText('unnamed reviewer')).toBeInTheDocument();
  });

  it('filters by document type', async () => {
    const listResults = vi.fn(async () => [result()]);
    const api = fakeApi({
      listResults,
      listSpecs: vi.fn(async () => [
        { id: 'pvp', version: 2, title: 'Process Validation Protocol' },
        { id: 'pvp', version: 3, title: 'Process Validation Protocol' },
        { id: 'invoice', version: 1, title: 'Invoice' },
      ]),
    });
    render(<ResultsPage api={api} />);
    const select = await screen.findByLabelText('Document type');
    await screen.findByRole('option', { name: 'Invoice' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All', 'Invoice', 'Process Validation Protocol']);
    await userEvent.selectOptions(select, 'pvp');
    expect(listResults).toHaveBeenLastCalledWith({ templateId: 'pvp', before: undefined });
  });

  it('loads more with the last publish time as the cursor', async () => {
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
    render(<ResultsPage api={fakeApi({ listResults })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(listResults).toHaveBeenLastCalledWith({
      templateId: undefined,
      before: page1[49]!.publishedAt,
      beforeId: page1[49]!.jobId,
    });
    expect(await screen.findByRole('link', { name: 'p2.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'p1-0.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('explains the empty state and shows load errors', async () => {
    const { unmount } = render(<ResultsPage api={fakeApi()} />);
    expect(await screen.findByText(/No published results yet/)).toHaveTextContent(
      'Test runs and rejected documents never appear here.',
    );
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
    const api = fakeApi({
      listResults,
      listSpecs: vi.fn(async () => [{ id: 'pvp', version: 3, title: 'PVP' }]),
    });
    render(<ResultsPage api={api} />);
    await screen.findByRole('option', { name: 'PVP' });
    await userEvent.selectOptions(screen.getByLabelText('Document type'), 'pvp');
    await act(async () => resolvePvp([result({ filename: 'pvp.pdf' })]));
    await act(async () => resolveAll([result({ filename: 'stale-all.pdf' })]));
    expect(screen.getByRole('link', { name: 'pvp.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'stale-all.pdf' })).not.toBeInTheDocument();
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
    expect(screen.getAllByRole('link', { name: 'p2.pdf' })).toHaveLength(1);
  });

  it('says when the selected document type has no results', async () => {
    const listResults = vi.fn(async (query?: { templateId?: string }) =>
      query?.templateId ? [] : [result()],
    );
    const api = fakeApi({
      listResults,
      listSpecs: vi.fn(async () => [{ id: 'pvp', version: 3, title: 'PVP' }]),
    });
    render(<ResultsPage api={api} />);
    await screen.findByRole('option', { name: 'PVP' });
    await userEvent.selectOptions(screen.getByLabelText('Document type'), 'pvp');
    expect(
      await screen.findByText('No published results for this document type.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No published results yet/)).not.toBeInTheDocument();
  });
});
