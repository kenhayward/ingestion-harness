import type { ResultSummary } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
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
});
