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
    expect(preview()).toHaveTextContent('pvp v3');
    expect(preview()).toHaveTextContent('Reviewed by Ken');
    expect(preview()).toHaveTextContent('1 issue');
    const fields = await within(preview()).findByRole('list', { name: 'Fields' });
    expect(within(fields).getByText('Product')).toBeInTheDocument();
    expect(within(fields).getByText('Aspirin')).toBeInTheDocument();
    expect(within(fields).getByText('B1, B2')).toBeInTheDocument();
    const table = within(preview()).getByRole('table', { name: 'Test results' });
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2
    // The table scrolls inside the panel: it never widens it.
    expect(table.closest('.preview-scroll')).not.toBeNull();
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
    expect(within(preview()).getByText(/Auto-approved/)).toBeInTheDocument();
  });

  it('shows the first fields only, saying how many there are', async () => {
    const detail = resultDetail();
    if (detail.definition.kind !== 'template') throw new Error('template expected');
    detail.definition.fields.push(
      { id: 'site', name: 'Site', type: 'text' },
      { id: 'author', name: 'Author', type: 'text' },
    );
    render(
      <ResultPreview api={fakeApi({ getResult: vi.fn(async () => detail) })} summary={summary()} />,
    );
    const fields = await within(preview()).findByRole('list', { name: 'Fields' });
    expect(within(fields).getAllByRole('listitem')).toHaveLength(6);
    expect(within(preview()).getByText('6 of 8')).toBeInTheDocument();
    expect(within(fields).queryByText('Author')).toBeNull();
  });

  it('lists the published files with their rows', () => {
    render(
      <ResultPreview
        api={fakeApi()}
        summary={summary({
          outputs: [
            { outputId: 'document', format: 'json', name: 'document.json', rowCount: null },
            { outputId: 'results', format: 'csv', name: 'results.csv', rowCount: 1 },
            { outputId: 'issues', format: 'csv', name: 'issues.csv', rowCount: 3 },
          ],
        })}
      />,
    );
    const files = within(preview()).getByRole('list', { name: 'Published files' });
    expect(
      within(files)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['JSONdocument.json', 'CSVresults.csv1 row', 'CSVissues.csv3 rows']);
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
