import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResultDetailView } from '../src/results/ResultDetail.js';
import { fakeApi } from './fake-api.js';
import { resultDetail } from './result-fixture.js';

const valueOf = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;

describe('ResultDetailView', () => {
  it('shows the header, review, target and published downloads', async () => {
    render(
      <ResultDetailView
        api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })}
        jobId="j1"
      />,
    );
    expect(await screen.findByRole('heading', { name: /protocol\.pdf/ })).toHaveTextContent(
      'pvp v3',
    );
    expect(valueOf('Review')).toHaveTextContent('Approved by Ken — Checked');
    expect(valueOf('Target')).toHaveTextContent('ingest-published/pvp/');
    const downloads = screen.getByRole('navigation', { name: 'Downloads' });
    expect(within(downloads).getByRole('link', { name: 'results.csv' })).toHaveAttribute(
      'href',
      '/api/jobs/j1/outputs/results?stage=published',
    );
  });

  it('renders labelled fields with formatted values and edit markers', async () => {
    render(
      <ResultDetailView
        api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })}
        jobId="j1"
      />,
    );
    expect(await screen.findByText('Product', { selector: 'dt' })).toBeInTheDocument();
    expect(valueOf('Product')).toHaveTextContent('Aspirin');
    expect(within(valueOf('Product')).getByText('edited')).toBeInTheDocument();
    expect(valueOf('batches')).toHaveTextContent('B1, B2');
    expect(valueOf('approved')).toHaveTextContent('true');
    expect(valueOf('extra')).toHaveTextContent('{"lot":7}');
    expect(valueOf('Missing value')).toHaveTextContent('—');
  });

  it('renders tables with template headings and marks edited cells', async () => {
    render(
      <ResultDetailView
        api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })}
        jobId="j1"
      />,
    );
    const table = await screen.findByRole('table', { name: 'Test results' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['#', 'Batch', 'value']);
    const cell = within(table).getAllByRole('row')[2]!.querySelectorAll('td')[2]!;
    expect(cell).toHaveTextContent('2');
    expect(cell).toHaveClass('edited-cell');
    // Not colour alone: edited cells carry a visible text marker too.
    expect(within(cell).getByText('edited')).toBeInTheDocument();
    const unedited = within(table).getAllByRole('row')[1]!.querySelectorAll('td')[2]!;
    expect(within(unedited).queryByText('edited')).not.toBeInTheDocument();
  });

  it('keeps checks and issues collapsed with counts', async () => {
    render(
      <ResultDetailView
        api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })}
        jobId="j1"
      />,
    );
    const issues = (await screen.findByText('Issues (1)')).closest('details')!;
    expect(issues).not.toHaveAttribute('open');
    expect(screen.getByText('Checks (1)').closest('details')).not.toHaveAttribute('open');
    const table = within(issues).getByRole('table', { name: 'Issues' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['step', 'target', 'row', 'column', 'raw', 'message']);
    expect(within(table).getByText('2,0O')).toBeInTheDocument();
  });

  it('falls back to document keys when the template is unknown', async () => {
    const detail = resultDetail({ definition: { kind: 'unknown' } });
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail) })} jobId="j1" />);
    expect(await screen.findByText('product', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'results' })).toBeInTheDocument();
  });

  it('shows document errors with the target and keeps downloads', async () => {
    const detail = resultDetail({ document: null, documentError: 'missing from target' });
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail) })} jobId="j1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The published document is missing from the target (bucket ingest-published).',
    );
    expect(screen.getByRole('navigation', { name: 'Downloads' })).toBeInTheDocument();
  });

  it.each([
    [
      'target storage unavailable',
      'The target storage could not be reached (bucket ingest-published).',
    ],
    [
      'invalid document',
      'The published document in the target is not valid (bucket ingest-published).',
    ],
  ] as const)('explains %s in plain words', async (documentError, message) => {
    const detail = resultDetail({ document: null, documentError });
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail) })} jobId="j1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('previews legacy outputs: CSV truncated to 500 rows, JSON pretty, failures inline', async () => {
    const csv = ['a,b', ...Array.from({ length: 501 }, (_, i) => `${i},"x,${i}"`)].join('\n');
    const detail = resultDetail({
      document: null,
      definition: { kind: 'spec' },
      outputs: [
        {
          outputId: 'lines',
          stage: 'published',
          format: 'csv',
          bucket: 'b',
          key: 'k/lines.csv',
          rowCount: 501,
        },
        {
          outputId: 'all',
          stage: 'published',
          format: 'json',
          bucket: 'b',
          key: 'k/all.json',
          rowCount: null,
        },
        {
          outputId: 'gone',
          stage: 'published',
          format: 'csv',
          bucket: 'b',
          key: 'k/gone.csv',
          rowCount: 1,
        },
      ],
    });
    const getOutputText = vi.fn(async (_j: string, outputId: string) => {
      if (outputId === 'lines') return csv;
      if (outputId === 'all') return '{"a":1}';
      throw new Error('output object missing from target');
    });
    render(
      <ResultDetailView
        api={fakeApi({ getResult: vi.fn(async () => detail), getOutputText })}
        jobId="j1"
      />,
    );
    const lines = await screen.findByRole('table', { name: 'lines.csv' });
    expect(within(lines).getAllByRole('row')).toHaveLength(501); // header + 500
    expect(within(lines).getByText('x,0')).toBeInTheDocument();
    expect(screen.getByText('Showing 500 of 501 rows')).toBeInTheDocument();
    expect(await screen.findByText(/"a": 1/)).toBeInTheDocument();
    expect(
      await screen.findByText('gone.csv: output object missing from target'),
    ).toBeInTheDocument();
    expect(getOutputText).toHaveBeenCalledWith('j1', 'lines', 'published');
  });

  it('shows not found with a way back', async () => {
    const getResult = vi.fn(async () => {
      throw new Error('result not found');
    });
    render(<ResultDetailView api={fakeApi({ getResult })} jobId="j1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('result not found');
    expect(screen.getByRole('link', { name: '← Results' })).toHaveAttribute('href', '#/results');
  });

  it('shows the recorded publish time, not the document or job timestamps', async () => {
    const detail = resultDetail();
    detail.document!.published_at = '2026-01-01T00:00:00Z';
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail) })} jobId="j1" />);
    await screen.findByText('Published', { selector: 'dt' });
    expect(valueOf('Published')).toHaveTextContent(
      new Date('2026-10-02T08:00:01.000Z').toLocaleString(),
    );
  });

  it('renders lists of objects as JSON items', async () => {
    render(
      <ResultDetailView
        api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })}
        jobId="j1"
      />,
    );
    await screen.findByText('lots', { selector: 'dt' });
    expect(valueOf('lots')).toHaveTextContent('{"lot":1}, {"lot":2}');
  });

  it('shows every column present in any row when the template is unknown', async () => {
    const detail = resultDetail({ definition: { kind: 'unknown' } });
    detail.document!.tables = { results: [{ batch: 'B1' }, { batch: 'B2', value: 2 }] };
    detail.document!.checks = {
      batch_check: { rows: [{ value: 'B1' }, { value: 'B2', status: 'ok' }] },
    };
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail) })} jobId="j1" />);
    const table = await screen.findByRole('table', { name: 'results' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['#', 'batch', 'value']);
    const checks = screen.getByRole('table', { name: 'batch_check' });
    expect(
      within(checks)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['value', 'status']);
  });

  it('announces loading states', async () => {
    render(
      <ResultDetailView
        api={fakeApi({ getResult: vi.fn(() => new Promise<never>(() => {})) })}
        jobId="j1"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('announces a preview that is still loading', async () => {
    const detail = resultDetail({
      document: null,
      definition: { kind: 'spec' },
      outputs: [
        {
          outputId: 'lines',
          stage: 'published',
          format: 'csv',
          bucket: 'b',
          key: 'k/lines.csv',
          rowCount: 1,
        },
      ],
    });
    const api = fakeApi({
      getResult: vi.fn(async () => detail),
      getOutputText: vi.fn(() => new Promise<string>(() => {})),
    });
    render(<ResultDetailView api={api} jobId="j1" />);
    // The page-level "Loading…" status comes first; wait for the preview's own.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Loading lines.csv'));
  });
});

describe('ResultDetailView help', () => {
  it('explains a published result from the top of the page', async () => {
    render(
      <ResultDetailView
        api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })}
        jobId="j1"
      />,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Help: Reading a published result' }),
    );
    expect(screen.getByRole('dialog', { name: 'Reading a published result' })).toBeInTheDocument();
  });
});
