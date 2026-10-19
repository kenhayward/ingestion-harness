import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShaclReport } from '@ih/shared';
import type { GraphRenderer } from '../src/rdf/GraphDiagram.js';
import { GraphTab } from '../src/review/GraphTab.js';
import { fakeApi } from './fake-api.js';

beforeEach(() => localStorage.clear());

const report: ShaclReport = {
  conforms: false,
  results: [
    {
      severity: 'Violation',
      shape: 'https://acme.example/def/LetterShape',
      focus: 'https://data.acme.example/doc/ab',
      path: 'https://acme.example/def/sentBy',
      output: 'sender',
      message: 'a letter names its sender',
      value: '',
    },
    {
      severity: 'Warning',
      shape: 'https://acme.example/def/LineShape',
      focus: 'https://data.acme.example/doc/ab/letter/lines/1',
      path: 'https://acme.example/def/qty',
      output: 'lines.qty',
      message: 'quantities are small',
      value: '900',
    },
  ],
};

describe('the Review Graph tab (ADR 0011 step 5)', () => {
  it('shows the Turtle and the SHACL results, each opening the output it names', async () => {
    const onOpen = vi.fn();
    const api = fakeApi({
      getOutputText: vi.fn(async () => '<a> <b> <c> .'),
      getShaclReport: vi.fn(async () => report),
    });
    render(<GraphTab api={api} jobId="j1" onOpenOutput={onOpen} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Turtle' }));
    expect(await screen.findByText('<a> <b> <c> .')).toBeInTheDocument();
    expect(api.getOutputText).toHaveBeenCalledWith('j1', 'graph', 'draft');
    const results = screen.getByRole('list', { name: 'SHACL results' });
    expect(within(results).getAllByRole('listitem')).toHaveLength(2);
    expect(results).toHaveTextContent('Violation');
    expect(results).toHaveTextContent('a letter names its sender');
    await userEvent.click(within(results).getByRole('button', { name: 'Show sender' }));
    expect(onOpen).toHaveBeenCalledWith('sender');
    await userEvent.click(within(results).getByRole('button', { name: 'Show lines.qty' }));
    expect(onOpen).toHaveBeenCalledWith('lines.qty');
  });

  it('says when the graph conforms, and when the recipe pins no shapes', async () => {
    const conforms = fakeApi({
      getOutputText: vi.fn(async () => ''),
      getShaclReport: vi.fn(async () => ({ conforms: true, results: [] })),
    });
    const { unmount } = render(<GraphTab api={conforms} jobId="j1" onOpenOutput={vi.fn()} />);
    expect(await screen.findByText('The graph conforms to the shapes.')).toBeInTheDocument();
    unmount();
    const none = fakeApi({
      getOutputText: vi.fn(async () => ''),
      getShaclReport: vi.fn(async () => null),
    });
    render(<GraphTab api={none} jobId="j1" onOpenOutput={vi.fn()} />);
    expect(await screen.findByText(/No SHACL report/)).toBeInTheDocument();
  });
});

describe('a result on a property no output publishes', () => {
  it('names the path and offers nothing to open', async () => {
    const api = fakeApi({
      getOutputText: vi.fn(async () => ''),
      getShaclReport: vi.fn(async () => ({
        conforms: false,
        results: [{ ...report.results[0]!, output: 'https://acme.example/def/signedBy' }],
      })),
    });
    render(<GraphTab api={api} jobId="j1" onOpenOutput={vi.fn()} />);
    const results = await screen.findByRole('list', { name: 'SHACL results' });
    expect(results).toHaveTextContent('https://acme.example/def/signedBy');
    expect(within(results).queryByRole('button')).toBeNull();
  });
});

/** The worker's golden graph (`worker/tests/fixtures/rdf/letter-graph.ttl`). */
const LETTER = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../worker/tests/fixtures/rdf/letter-graph.ttl',
  ),
  'utf8',
);
const DOC = 'https://data.acme.example/ct/doc/ab12';
const ACME = 'https://acme.example/def/';
const PARTY = 'https://data.acme.example/ct/party/unicorn-labs-ltd';
const letterApi = (shacl: ShaclReport | null = null) =>
  fakeApi({
    getOutputText: vi.fn(async () => LETTER),
    getShaclReport: vi.fn(async () => shacl),
    termLabels: vi.fn(async () => ({
      terms: {
        [`${ACME}Letter`]: {
          from: 'ontology' as const,
          iri: `${ACME}Letter`,
          label: 'Business letter',
          kind: 'class' as const,
          ontology: 'acme@1',
          deprecated: false,
          altLabels: [],
          definition: null,
        },
      },
    })),
  });
const rowOf = (card: HTMLElement, name: string) =>
  within(card).getByRole('rowheader', { name }).closest('tr') as HTMLElement;

describe('the Cards view', () => {
  it('is the default: one card per entity, the document first, named from the ontology', async () => {
    render(<GraphTab api={letterApi()} jobId="j1" onOpenOutput={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Business letter ab12' })).toBeVisible();
    const cards = screen.getAllByRole('article');
    expect(cards.map((c) => within(c).getAllByRole('heading')[0]!.textContent)).toEqual([
      'Business letter ab12',
      'Line 2',
      'Line AB-1',
      'Ünïcorn Labs Ltd',
    ]);
    expect(screen.getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/4 entities · 114 triples/)).toBeInTheDocument();
  });

  it("asks for names of the types, properties and terms with the recipe's pins", async () => {
    const api = letterApi();
    render(
      <GraphTab
        api={api}
        jobId="j1"
        onOpenOutput={vi.fn()}
        semantics={{ ontologies: [{ id: 'acme', version: 1 }], prefixes: { acme: ACME } }}
      />,
    );
    await screen.findAllByRole('article');
    await waitFor(() => expect(api.termLabels).toHaveBeenCalled());
    const body = vi.mocked(api.termLabels).mock.calls[0]![0];
    expect(body.ontologies).toEqual([{ id: 'acme', version: 1 }]);
    expect(body.prefixes).toEqual({ acme: ACME });
    expect(body.terms).toEqual(expect.arrayContaining([`${ACME}Letter`, `${ACME}sentBy`]));
  });

  it('shows values as people read them, with their evidence', async () => {
    render(<GraphTab api={letterApi()} jobId="j1" onOpenOutput={vi.fn()} />);
    const doc = await screen.findByRole('article', { name: 'Business letter ab12' });
    expect(rowOf(doc, 'Sent')).toHaveTextContent('11 February 2023');
    expect(rowOf(doc, 'Urgent')).toHaveTextContent('Yes');
    expect(rowOf(doc, 'Kind')).toHaveTextContent('Memo');
    expect(rowOf(doc, 'Tag')).toHaveTextContent('a');
    expect(rowOf(doc, 'Sent by')).toHaveTextContent('p. 1');
    expect(rowOf(doc, 'Sent by')).toHaveTextContent('From: Ünïcorn Labs Ltd');
    expect(screen.getByText(/Recipe letter v3/)).toBeInTheDocument();
  });

  it("links to other entities' cards and back", async () => {
    render(<GraphTab api={letterApi()} jobId="j1" onOpenOutput={vi.fn()} />);
    const doc = await screen.findByRole('article', { name: 'Business letter ab12' });
    await userEvent.click(within(doc).getByRole('button', { name: 'Ünïcorn Labs Ltd' }));
    const party = screen.getByRole('article', { name: 'Ünïcorn Labs Ltd' });
    expect(party).toHaveFocus();
    expect(party).toHaveTextContent('Linked from');
    await userEvent.click(within(party).getByRole('button', { name: 'Business letter ab12' }));
    expect(doc).toHaveFocus();
  });

  it('marks a SHACL result on its row, and a missing value as a row of its own', async () => {
    const onOpen = vi.fn();
    const shacl: ShaclReport = {
      conforms: false,
      results: [
        {
          severity: 'Violation',
          shape: `${ACME}LetterShape`,
          focus: DOC,
          path: `${ACME}sentBy`,
          output: 'sender',
          message: 'a sender is a known party',
          value: PARTY,
        },
        {
          severity: 'Violation',
          shape: `${ACME}LetterShape`,
          focus: DOC,
          path: `${ACME}signedBy`,
          output: `${ACME}signedBy`,
          message: 'a letter is signed',
          value: '',
        },
      ],
    };
    render(<GraphTab api={letterApi(shacl)} jobId="j1" onOpenOutput={onOpen} />);
    const doc = await screen.findByRole('article', { name: 'Business letter ab12' });
    expect(doc).toHaveTextContent('2 violations');
    const sent = rowOf(doc, 'Sent by');
    expect(sent).toHaveClass('rdf-row-violation');
    expect(sent).toHaveTextContent('a sender is a known party');
    await userEvent.click(within(sent).getByRole('button', { name: 'Show sender' }));
    expect(onOpen).toHaveBeenCalledWith('sender');
    const signed = rowOf(doc, 'Signed by');
    expect(signed).toHaveTextContent('Missing');
    expect(signed).toHaveTextContent('a letter is signed');
  });

  it('falls back to the Turtle when the graph cannot be read', async () => {
    const api = fakeApi({ getOutputText: vi.fn(async () => '<a> <b> .') });
    render(<GraphTab api={api} jobId="j1" onOpenOutput={vi.fn()} />);
    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(screen.getByText('<a> <b> .')).toBeInTheDocument();
  });
});

describe('the Diagram view', () => {
  it("draws the entities and their links, and opens a picked entity's card", async () => {
    let picked: ((iri: string) => void) | undefined;
    const renderer = vi.fn<GraphRenderer>((_el, _data, onSelect) => {
      picked = onSelect;
      return () => undefined;
    });
    render(<GraphTab api={letterApi()} jobId="j1" onOpenOutput={vi.fn()} renderer={renderer} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Diagram' }));
    await waitFor(() => expect(renderer).toHaveBeenCalled());
    const data = renderer.mock.lastCall![1];
    expect(data.nodes.map((n) => [n.label, n.root])).toEqual([
      ['Business letter ab12', true],
      ['Line 2', false],
      ['Line AB-1', false],
      ['Ünïcorn Labs Ltd', false],
    ]);
    expect(data.edges).toContainEqual({ source: DOC, target: PARTY, label: 'Sent by' });
    expect(screen.getByText(/Pick an entity/)).toBeInTheDocument();
    act(() => picked!(PARTY));
    expect(screen.getByRole('article', { name: 'Ünïcorn Labs Ltd' })).toBeInTheDocument();
  });

  it('is remembered', async () => {
    const renderer = vi.fn<GraphRenderer>(() => () => undefined);
    const { unmount } = render(
      <GraphTab api={letterApi()} jobId="j1" onOpenOutput={vi.fn()} renderer={renderer} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Diagram' }));
    unmount();
    render(<GraphTab api={letterApi()} jobId="j1" onOpenOutput={vi.fn()} renderer={renderer} />);
    expect(await screen.findByRole('button', { name: 'Diagram' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('help', () => {
  it('opens Reading a graph from the Graph heading', async () => {
    render(<GraphTab api={letterApi()} jobId="j1" onOpenOutput={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Help: Reading a graph' }));
    expect(await screen.findByRole('dialog', { name: 'Reading a graph' })).toBeInTheDocument();
  });
});
