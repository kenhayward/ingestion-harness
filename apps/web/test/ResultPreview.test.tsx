import type { ResultSummary } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ResultPreview } from '../src/results/ResultPreview.js';
import { ResultsPage } from '../src/results/ResultsPage.js';
import { fakeApi } from './fake-api.js';
import { resultDetail } from './result-fixture.js';

const summary = (o: Partial<ResultSummary> = {}): ResultSummary => ({
  jobId: 'j1',
  documentId: 'd',
  filename: 'protocol.pdf',
  contentType: 'application/pdf',
  specId: 'pvp',
  specVersion: 3,
  publishedAt: '2026-10-02T08:00:01.000Z',
  reviewer: 'Ken',
  reviewedAt: '2026-10-02T08:00:00Z',
  outputCount: 2,
  outputs: [],
  issueCount: 1,
  ...o,
});

const preview = () => screen.getByRole('complementary', { name: 'Result preview' });

describe('ResultPreview', () => {
  it('shows the fields and the first rows of the first table', async () => {
    const api = fakeApi({ getResult: vi.fn(async () => resultDetail()) });
    render(<ResultPreview api={api} summary={summary()} />);
    expect(within(preview()).getByRole('heading', { name: 'protocol.pdf' })).toBeInTheDocument();
    expect(
      within(preview()).getByText(/pvp v3 · published .* · reviewed by Ken/),
    ).toBeInTheDocument();
    const fields = await within(preview()).findByRole('list', { name: 'Fields' });
    expect(within(fields).getByText('Product')).toBeInTheDocument();
    expect(within(fields).getByText('Aspirin')).toBeInTheDocument();
    expect(within(fields).getByText('B1, B2')).toBeInTheDocument();
    const table = within(preview()).getByRole('table', { name: 'Test results' });
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2
    // The row carries Open full result and View PDF; the panel has no links of its own.
    expect(within(preview()).queryAllByRole('link')).toEqual([]);
  });

  it('shows at most 3 table rows', async () => {
    const detail = resultDetail();
    detail.document!.tables.results = [1, 2, 3, 4, 5].map((n) => ({ batch: `B${n}`, value: n }));
    render(
      <ResultPreview api={fakeApi({ getResult: vi.fn(async () => detail) })} summary={summary()} />,
    );
    const table = await within(preview()).findByRole('table', { name: 'Test results' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(preview()).getByText('Showing 3 of 5 rows')).toBeInTheDocument();
  });

  it('says auto-approved when nobody reviewed it', () => {
    render(
      <ResultPreview api={fakeApi()} summary={summary({ reviewer: null, reviewedAt: null })} />,
    );
    expect(within(preview()).getByText(/auto-approved/)).toBeInTheDocument();
  });

  it('has no field preview for legacy spec results', async () => {
    const api = fakeApi({
      getResult: vi.fn(async () => resultDetail({ document: null, definition: { kind: 'spec' } })),
    });
    render(<ResultPreview api={api} summary={summary()} />);
    expect(await screen.findByText('No preview for this document type.')).toBeInTheDocument();
  });

  it('says when a template result has no published document', async () => {
    const api = fakeApi({ getResult: vi.fn(async () => resultDetail({ document: null })) });
    render(<ResultPreview api={api} summary={summary()} />);
    expect(await screen.findByText('No published document to preview.')).toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    const api = fakeApi({
      getResult: vi.fn(async () => {
        throw new Error('502 Bad Gateway');
      }),
    });
    render(<ResultPreview api={api} summary={summary()} />);
    expect(await screen.findByText(/Couldn't load the preview: 502/)).toBeInTheDocument();
  });

  it('reports a document missing from the target', async () => {
    const api = fakeApi({
      getResult: vi.fn(async () =>
        resultDetail({ document: null, documentError: 'missing from target' }),
      ),
    });
    render(<ResultPreview api={api} summary={summary()} />);
    expect(
      await screen.findByText(/The published document is missing from the target/),
    ).toBeInTheDocument();
  });
});

describe('ResultsPage preview', () => {
  it('previews the first result by default and follows the selection', async () => {
    const getResult = vi.fn(async (id: string) =>
      resultDetail({ job: { ...resultDetail().job, id } }),
    );
    const listResults = vi.fn(async () => [
      summary({ jobId: 'a', filename: 'a.pdf' }),
      summary({ jobId: 'b', filename: 'b.pdf' }),
    ]);
    render(<ResultsPage api={fakeApi({ listResults, getResult })} />);
    expect(
      await within(await screen.findByRole('complementary', { name: 'Result preview' })).findByRole(
        'heading',
        { name: 'a.pdf' },
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show preview of b.pdf' }));
    expect(within(preview()).getByRole('heading', { name: 'b.pdf' })).toBeInTheDocument();
    expect(getResult).toHaveBeenLastCalledWith('b');
  });
});
