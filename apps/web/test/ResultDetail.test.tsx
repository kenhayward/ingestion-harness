import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResultDetailView } from '../src/results/ResultDetail.js';
import { fullWhen } from '../src/results/format.js';
import { fakeApi } from './fake-api.js';
import { resultDetail } from './result-fixture.js';

const valueOf = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;
const outline = () => screen.getByRole('navigation', { name: 'Result contents' });
const open = async (name: string) =>
  userEvent.click(
    within(await screen.findByRole('navigation', { name: 'Result contents' })).getByRole('button', {
      name,
    }),
  );
const show = (detail = resultDetail()) =>
  render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail) })} jobId="j1" />);

describe('ResultDetailView', () => {
  it('shows the header, review, target and published downloads', async () => {
    render(
      <ResultDetailView
        api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })}
        jobId="j1"
      />,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'protocol.pdf' }),
    ).toBeInTheDocument();
    expect(screen.getByText('pvp v3')).toBeInTheDocument();
    expect(valueOf('Review')).toHaveTextContent('Approved by Ken — Checked');
    expect(valueOf('Publishing target')).toHaveTextContent('Default');
    expect(valueOf('Publishing target')).toHaveTextContent('ingest-published/pvp/');
    const actions = screen.getByRole('group', { name: 'Actions' });
    expect(within(actions).getByRole('link', { name: 'View PDF of protocol.pdf' })).toHaveAttribute(
      'href',
      '/api/jobs/j1/document',
    );
    expect(
      within(actions).getByRole('link', { name: 'Download protocol.pdf results as ZIP' }),
    ).toHaveAttribute('href', '/api/results/j1/archive');
    await open('Published files');
    const files = screen.getByRole('list', { name: 'Published files' });
    expect(within(files).getByRole('link', { name: 'results.csv' })).toHaveAttribute(
      'href',
      '/api/jobs/j1/outputs/results?stage=published',
    );
    expect(within(files).getByText('2 rows')).toBeInTheDocument();
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

  it('sums up fields, tables, checks and issues in tiles', async () => {
    show();
    const tiles = await screen.findByRole('list', { name: 'Summary' });
    expect(
      within(tiles)
        .getAllByRole('listitem')
        .map((t) => t.textContent),
    ).toEqual([
      'Fields61 edited in review',
      'Tables12 rows · 1 cell edited',
      'Checks1all matched',
      'Issues11 to look at',
    ]);
  });

  it('counts a cell edited twice in review once', async () => {
    const detail = resultDetail();
    // The review's edits are a log: a second edit of the same cell is not another edited cell.
    detail.document!.review!.edits.push({ table: 'results', row: 2, column: 'value', value: 3 });
    show(detail);
    const tiles = await screen.findByRole('list', { name: 'Summary' });
    expect(within(tiles).getAllByRole('listitem')[1]).toHaveTextContent(
      'Tables12 rows · 1 cell edited',
    );
    expect(within(outline()).getByRole('button', { name: 'Test results' })).toHaveTextContent(
      '2 · 1 edited',
    );
    await open('Test results');
    expect(screen.getByRole('region', { name: 'Test results' })).toHaveTextContent(
      '1 cell edited in review',
    );
  });

  it('lists the contents in an outline and opens one item at a time, fields first', async () => {
    show();
    await screen.findByRole('navigation', { name: 'Result contents' });
    expect(
      within(outline())
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Fields', 'Test results', 'batch_check', 'Issues', 'Published files']);
    expect(within(outline()).getByRole('button', { name: 'Fields' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('region', { name: 'Fields' })).toBeInTheDocument();
    await open('Test results');
    expect(screen.queryByRole('region', { name: 'Fields' })).toBeNull();
    const region = screen.getByRole('region', { name: 'Test results' });
    expect(region).toHaveTextContent('2 rows · 2 columns');
    expect(
      within(region).getByRole('link', { name: 'Download Test results as CSV' }),
    ).toHaveAttribute('href', '/api/jobs/j1/outputs/results?stage=published');
    await userEvent.click(within(region).getByRole('button', { name: 'Next: batch_check' }));
    expect(screen.getByRole('region', { name: 'batch_check' })).toBeInTheDocument();
  });

  it("filters a table's rows", async () => {
    show();
    await open('Test results');
    const region = screen.getByRole('region', { name: 'Test results' });
    await userEvent.type(within(region).getByRole('searchbox', { name: 'Filter rows' }), 'b2');
    const table = within(region).getByRole('table', { name: 'Test results' });
    expect(within(table).getAllByRole('row')).toHaveLength(2); // header + B2
    expect(within(table).getByText('B2')).toBeInTheDocument();
    expect(region).toHaveTextContent('1 of 2 rows');
  });

  it('shows a matching check as values, results and what each matched', async () => {
    const detail = resultDetail();
    detail.document!.checks = {
      batch_numbers: {
        rows: [
          { value: '4586783', status: 'match', matched: '4586783', distance: 0, count: 4 },
          { value: '4586 79O', status: 'near', matched: '4586790', distance: 2, count: 1 },
          { value: '4586 783', status: 'alias', matched: '4586783', distance: 0, count: 1 },
          { value: 'LDLS000', status: 'unused', matched: null, distance: null, count: 0 },
        ],
      },
    };
    show(detail);
    expect(await screen.findByRole('navigation', { name: 'Result contents' })).toHaveTextContent(
      '2 to look at',
    );
    await open('batch_numbers');
    const table = screen.getByRole('table', { name: 'batch_numbers' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Value found', 'Result', 'Matched to', 'Edit distance', 'Times seen']);
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('4586 79ONear match45867902');
    expect(screen.getByRole('region', { name: 'batch_numbers' })).toHaveTextContent(
      '1 exact · 1 alias · 1 near · 0 not found · 1 not used',
    );
  });

  it("shows a check plugin's message in the check view", async () => {
    const detail = resultDetail();
    detail.document!.checks = {
      batch_numbers: {
        rows: [
          { value: '4586783', status: 'match', matched: '4586783', distance: 0, count: 1 },
          {
            value: 'ZZ9',
            status: 'unmatched',
            matched: null,
            distance: null,
            count: 1,
            message: 'ZZ9 is not a released batch',
          },
        ],
      },
    };
    show(detail);
    await open('batch_numbers');
    const table = screen.getByRole('table', { name: 'batch_numbers' });
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('ZZ9 is not a released batch');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toContain('Note');
  });

  it('renders tables with template headings and marks edited cells', async () => {
    show();
    await open('Test results');
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

  it('shows the issues with their counts in the outline', async () => {
    show();
    await open('Issues');
    const table = screen.getByRole('table', { name: 'Issues' });
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
    await open('results');
    expect(screen.getByRole('table', { name: 'results' })).toBeInTheDocument();
  });

  it('shows document errors with the target and keeps downloads', async () => {
    const detail = resultDetail({ document: null, documentError: 'missing from target' });
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail) })} jobId="j1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The published document is missing from the target (bucket ingest-published).',
    );
    expect(screen.getByRole('list', { name: 'Published files' })).toBeInTheDocument();
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
          targetId: 'default',
        },
        {
          outputId: 'all',
          stage: 'published',
          format: 'json',
          bucket: 'b',
          key: 'k/all.json',
          rowCount: null,
          targetId: 'default',
        },
        {
          outputId: 'gone',
          stage: 'published',
          format: 'csv',
          bucket: 'b',
          key: 'k/gone.csv',
          rowCount: 1,
          targetId: 'default',
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
    expect(screen.getByRole('link', { name: 'Results' })).toHaveAttribute('href', '#/results');
  });

  it('shows the recorded publish time, not the document or job timestamps', async () => {
    const detail = resultDetail();
    detail.document!.published_at = '2026-01-01T00:00:00Z';
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail) })} jobId="j1" />);
    await screen.findByText('Published', { selector: 'dt' });
    expect(valueOf('Published')).toHaveTextContent(fullWhen('2026-10-02T08:00:01.000Z'));
    expect(fullWhen('2026-10-02T08:00:01.000Z')).not.toBe(fullWhen('2026-01-01T00:00:00Z'));
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
    await open('results');
    const table = await screen.findByRole('table', { name: 'results' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['#', 'batch', 'value']);
    await open('batch_check');
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
          targetId: 'default',
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

describe('a result that delivered RDF', () => {
  const A = 'https://acme.example/def/';
  const TTL = `<https://d/doc/x> a <${A}Letter> ; <${A}sentBy> <https://d/party/p> .
<https://d/party/p> a <${A}Party> ; <http://www.w3.org/2000/01/rdf-schema#label> "Ünïcorn" .`;
  const graph = {
    outputId: 'graph',
    stage: 'published' as const,
    format: 'rdf' as const,
    bucket: 'ingest-published',
    key: 'pvp/x/graph/d.ttl',
    rowCount: 3,
    targetId: 'default',
  };

  it('has a Graph item showing the published graph as cards, named with the recipe pins', async () => {
    const base = resultDetail();
    const detail = resultDetail({
      outputs: [...base.outputs, graph],
      definition: {
        ...(base.definition as Extract<typeof base.definition, { kind: 'template' }>),
        semantics: { ontologies: [{ id: 'acme', version: 1 }], prefixes: { acme: A }, local: [] },
      },
    });
    const getOutputText = vi.fn(async () => TTL);
    const api = fakeApi({ getResult: vi.fn(async () => detail), getOutputText });
    render(<ResultDetailView api={api} jobId="j1" />);
    await screen.findByRole('navigation', { name: 'Result contents' });
    expect(
      within(outline())
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Fields', 'Test results', 'batch_check', 'Graph', 'Issues', 'Published files']);
    // Read only when opened.
    expect(getOutputText).not.toHaveBeenCalled();
    await open('Graph');
    expect(getOutputText).toHaveBeenCalledWith('j1', 'graph', 'published');
    const region = screen.getByRole('region', { name: 'Graph' });
    expect(await within(region).findByRole('article', { name: 'Letter x' })).toBeInTheDocument();
    expect(within(region).getByRole('article', { name: 'Ünïcorn' })).toBeInTheDocument();
    await waitFor(() =>
      expect(api.termLabels).toHaveBeenCalledWith(
        expect.objectContaining({ ontologies: [{ id: 'acme', version: 1 }] }),
      ),
    );
  });

  it('reads the graph as a graph, not as CSV, when there is no document', async () => {
    const detail = resultDetail({ document: null, definition: { kind: 'spec' }, outputs: [graph] });
    render(
      <ResultDetailView
        api={fakeApi({
          getResult: vi.fn(async () => detail),
          getOutputText: vi.fn(async () => TTL),
        })}
        jobId="j1"
      />,
    );
    expect(await screen.findByRole('article', { name: 'Letter x' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'graph.rdf' })).toBeNull();
  });
});
