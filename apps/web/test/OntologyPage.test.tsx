import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TermPage } from '@ih/shared';
import type { Api, OntologyTermQuery } from '../src/api/client.js';
import { OntologyPage } from '../src/ontologies/OntologyPage.js';
import {
  fakeApi,
  ontologyDetail,
  ontologySummary,
  ontologyTerm,
  ontologyVersion,
  termDetail,
} from './fake-api.js';

const C = 'https://example.org/pv#';
const page = (items = [ontologyTerm()]): TermPage => ({
  items,
  total: items.length,
  offset: 0,
  limit: 100,
});

function view(role: 'admin' | 'designer' = 'designer', overrides: Partial<Api> = {}) {
  const api = fakeApi({
    getOntology: vi.fn(async () => ontologyDetail()),
    listOntologyTerms: vi.fn(async (_id: string, _v: number, q: OntologyTermQuery) =>
      q.q
        ? page([ontologyTerm({ iri: `${C}Protocol`, label: 'Protocol' })])
        : q.parent
          ? page([
              ontologyTerm({ iri: `${C}Protocol`, label: 'Protocol', parents: [`${C}Document`] }),
            ])
          : page([ontologyTerm({ childCount: 1 })]),
    ),
    getOntologyTerm: vi.fn(async (_id: string, _v: number, iri: string) =>
      iri.endsWith('Protocol')
        ? termDetail({
            iri,
            label: 'Protocol',
            parents: [`${C}Document`, 'https://other.org/Thing'],
            parentTerms: [{ iri: `${C}Document`, kind: 'class', label: 'Document' }],
          })
        : termDetail({
            definition: 'Anything written down.',
            children: [{ iri: `${C}Protocol`, kind: 'class', label: 'Protocol' }],
          }),
    ),
    ...overrides,
  });
  render(
    <OntologyPage
      api={api}
      role={role}
      ontologyId="pv"
      pollMs={10}
      searchDelayMs={0}
      graphRenderer={() => () => {}}
    />,
  );
  return api;
}

describe('OntologyPage', () => {
  it('shows the ontology, its version and a download link', async () => {
    view();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Process validation' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download pv\.ttl/ })).toHaveAttribute(
      'href',
      '/api/ontologies/pv/versions/1/source',
    );
    expect(screen.getByText('https://example.org/pv')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });

  it('lazily expands the class tree and shows a term', async () => {
    const api = view();
    const tree = await screen.findByRole('tree', { name: 'Classes hierarchy' });
    expect(api.listOntologyTerms).toHaveBeenCalledWith('pv', 1, {
      group: 'classes',
      root: true,
      limit: 500,
    });
    await userEvent.click(within(tree).getByRole('button', { name: 'Expand Document' }));
    await within(tree).findByRole('treeitem', { name: /Protocol/ });
    expect(api.listOntologyTerms).toHaveBeenCalledWith('pv', 1, {
      group: 'classes',
      parent: `${C}Document`,
      limit: 500,
    });
    await userEvent.click(within(tree).getByRole('treeitem', { name: /Protocol/ }));
    const panel = await screen.findByRole('region', { name: 'Term details' });
    expect(await within(panel).findByRole('heading', { name: 'Protocol' })).toBeInTheDocument();
    // An outside parent shows as its IRI; a known one can be followed.
    expect(within(panel).getByText('https://other.org/Thing')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Document' }));
    expect(await within(panel).findByText('Anything written down.')).toBeInTheDocument();
  });

  it('moves through the tree with the keyboard', async () => {
    view();
    const tree = await screen.findByRole('tree', { name: 'Classes hierarchy' });
    const document = await within(tree).findByRole('treeitem', { name: /Document/ });
    document.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(await within(tree).findByRole('treeitem', { name: /Protocol/ })).toBeInTheDocument();
    expect(document).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByRole('heading', { name: 'Protocol' })).toBeInTheDocument();
  });

  it('moves back to the parent with ArrowLeft on real IRIs', async () => {
    view();
    const tree = await screen.findByRole('tree', { name: 'Classes hierarchy' });
    const document = await within(tree).findByRole('treeitem', { name: /Document/ });
    document.focus();
    await userEvent.keyboard('{ArrowRight}');
    const protocol = await within(tree).findByRole('treeitem', { name: /Protocol/ });
    await userEvent.keyboard('{ArrowDown}');
    expect(protocol).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(document).toHaveFocus();
  });

  it('shows a term as a graph', async () => {
    view('designer', {
      getNeighbourhood: vi.fn(async () => ({
        nodes: [
          { iri: `${C}Protocol`, label: 'Protocol', kind: 'class' as const, focus: true },
          { iri: `${C}Document`, label: 'Document', kind: 'class' as const, focus: false },
        ],
        edges: [{ source: `${C}Protocol`, target: `${C}Document`, kind: 'subClassOf' as const }],
        truncated: false,
      })),
    });
    const tree = await screen.findByRole('tree');
    await userEvent.click(await within(tree).findByRole('treeitem', { name: /Document/ }));
    const view_ = screen.getByRole('group', { name: 'View' });
    await userEvent.click(within(view_).getByRole('button', { name: 'Graph' }));
    expect(await screen.findByRole('list', { name: 'Links' })).toBeInTheDocument();
  });

  it('searches terms instead of the tree', async () => {
    const api = view();
    await screen.findByRole('tree');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search terms' }), 'proto');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(within(results).getByRole('button', { name: /Protocol/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(api.listOntologyTerms).toHaveBeenCalledWith('pv', 1, {
        group: 'classes',
        q: 'proto',
        limit: 100,
      }),
    );
  });

  it('switches tabs by term kind with counts', async () => {
    const api = view();
    await screen.findByRole('tree');
    const kinds = screen.getByRole('group', { name: 'Term kinds' });
    await userEvent.click(within(kinds).getByRole('button', { name: 'Properties (2)' }));
    await screen.findByRole('tree', { name: 'Properties hierarchy' });
    expect(api.listOntologyTerms).toHaveBeenCalledWith('pv', 1, {
      group: 'properties',
      root: true,
      limit: 500,
    });
  });

  it('says a version is importing or failed instead of browsing it', async () => {
    view('designer', {
      getOntology: vi.fn(async () =>
        ontologyDetail({
          versions: [ontologyVersion({ status: 'failed', error: 'cannot read pv.ttl as Turtle' })],
        }),
      ),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Import failed: cannot read pv.ttl as Turtle',
    );
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it('shows how each import was resolved, and where a URL version came from', async () => {
    view('designer', {
      getOntology: vi.fn(async () =>
        ontologyDetail({
          versions: [
            ontologyVersion({
              sourceKind: 'url',
              sourceUrl: 'https://w3id.org/pv',
              imports: [
                {
                  iri: 'https://w3id.org/lib',
                  resolution: 'library',
                  ontologyId: 'lib',
                  version: 4,
                  reason: null,
                },
                {
                  iri: 'https://w3id.org/base',
                  resolution: 'fetched',
                  ontologyId: 'w3id-org-base',
                  version: 1,
                  reason: null,
                },
                {
                  iri: 'https://nope.org/x',
                  resolution: 'unresolved',
                  ontologyId: null,
                  version: null,
                  reason: 'nope.org is not on ONTOLOGY_FETCH_ALLOW',
                },
              ],
            }),
          ],
        }),
      ),
    });
    expect(await screen.findByText('Imports: 2 resolved, 1 not')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'lib v4' })).toHaveAttribute(
      'href',
      '#/ontologies/lib',
    );
    expect(screen.getByRole('link', { name: 'w3id-org-base v1' })).toHaveAttribute(
      'href',
      '#/ontologies/w3id-org-base',
    );
    expect(screen.getByText(/fetched into the library/)).toBeInTheDocument();
    expect(screen.getByText('nope.org is not on ONTOLOGY_FETCH_ALLOW')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://w3id.org/pv' })).toHaveAttribute(
      'href',
      'https://w3id.org/pv',
    );
  });

  it('lists the files of a folder version, and imports between them as included', async () => {
    view('designer', {
      getOntology: vi.fn(async () =>
        ontologyDetail({
          versions: [
            ontologyVersion({
              sourceKind: 'files',
              fileName: 'idmp',
              sourceFiles: [
                { fileName: 'idmp/core.ttl', sha256: 'a', bytes: 1200 },
                { fileName: 'idmp/sub/prod.ttl', sha256: 'b', bytes: 3400 },
              ],
              imports: [
                {
                  iri: 'https://w3id.org/idmp/core',
                  resolution: 'included',
                  ontologyId: null,
                  version: null,
                  reason: null,
                },
                {
                  iri: 'https://nope.org/x',
                  resolution: 'unresolved',
                  ontologyId: null,
                  version: null,
                  reason: 'not in the library',
                },
              ],
            }),
          ],
        }),
      ),
    });
    expect(await screen.findByText('Imports: 1 resolved, 1 not')).toBeInTheDocument();
    expect(screen.getByText(/one of this version's files/)).toBeInTheDocument();
    const source = screen.getByText('2 files from idmp');
    expect(source).toBeInTheDocument();
    const files = screen.getByRole('list', { name: 'Files of this version' });
    expect(files).toHaveTextContent('idmp/core.ttl');
    expect(files).toHaveTextContent('idmp/sub/prod.ttl');
    // No single file to download for a folder version.
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
  });

  it('marks terms that come from an import', async () => {
    view('designer', {
      getOntologyTerm: vi.fn(async () =>
        termDetail({ label: 'Thing', definedIn: 'w3id-org-base@1' }),
      ),
    });
    const tree = await screen.findByRole('tree');
    await userEvent.click(await within(tree).findByRole('treeitem', { name: /Document/ }));
    expect(await screen.findByText('From w3id-org-base@1')).toBeInTheDocument();
  });

  it('lists the remembered mappings that use a term', async () => {
    const api = view('designer', {
      getOntologyTerm: vi.fn(async () => termDetail({ label: 'Batch identifier' })),
      listMappingMemory: vi.fn(async () => ({
        total: 1,
        labels: {},
        entries: [
          {
            id: 'm-1',
            kind: 'column' as const,
            signatureKey: 'value|batch number|text|',
            name: 'Batch number',
            description: '',
            type: 'text',
            unit: '',
            answer: {
              form: 'entity' as const,
              property: 'x:has',
              class: 'x:Batch',
              iri: 'b/{value}',
            },
            ontologies: ['pv'],
            status: 'confirmed' as const,
            stale: null,
            votes: 4,
            refusals: 0,
            recipes: [],
            reviewedBy: 'Ada',
            reviewedAt: null,
            note: null,
            updatedAt: '2026-10-18T12:00:00.000Z',
          },
        ],
      })),
    });
    const tree = await screen.findByRole('tree');
    await userEvent.click(await within(tree).findByRole('treeitem', { name: /Document/ }));
    const list = await screen.findByRole('list', { name: 'Remembered for' });
    expect(list).toHaveTextContent('Batch number in 4 recipes (confirmed)');
    expect(api.listMappingMemory).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'all', term: expect.any(String) }),
    );
  });

  it('opens at the term a mapping panel linked to', async () => {
    const api = fakeApi({
      getOntology: vi.fn(async () => ontologyDetail()),
      listOntologyTerms: vi.fn(async () => page([ontologyTerm({ childCount: 1 })])),
      getOntologyTerm: vi.fn(async (_id: string, _v: number, iri: string) =>
        termDetail({ iri, label: 'Protocol' }),
      ),
    });
    render(
      <OntologyPage
        api={api}
        role="designer"
        ontologyId="pv"
        version={1}
        term={`${C}Protocol`}
        pollMs={10}
        searchDelayMs={0}
        graphRenderer={() => () => {}}
      />,
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Protocol' })).toBeInTheDocument();
    expect(api.getOntologyTerm).toHaveBeenCalledWith('pv', 1, `${C}Protocol`);
  });

  it('offers no download for a URL version not fetched yet', async () => {
    view('designer', {
      getOntology: vi.fn(async () =>
        ontologyDetail({
          versions: [
            ontologyVersion({
              status: 'queued',
              sourceKind: 'url',
              sourceUrl: 'https://w3id.org/pv',
              sha256: null,
              bytes: null,
            }),
          ],
        }),
      ),
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('lets admins edit and delete a version', async () => {
    const api = view('admin', {
      updateOntology: vi.fn(async () => ontologySummary({ label: 'PV' })),
      deleteOntologyVersion: vi.fn(async () => undefined),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit…' }));
    const edit = screen.getByRole('dialog', { name: 'Edit ontology' });
    await userEvent.clear(within(edit).getByLabelText('Name'));
    await userEvent.type(within(edit).getByLabelText('Name'), 'PV');
    await userEvent.click(within(edit).getByLabelText('Retired'));
    await userEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateOntology).toHaveBeenCalledWith('pv', {
        label: 'PV',
        description: '',
        tags: ['industry:pharma'],
        localOnly: false,
        retired: true,
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete version…' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete version 1' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete version' }));
    await waitFor(() => expect(api.deleteOntologyVersion).toHaveBeenCalledWith('pv', 1));
  });
});

describe('OntologyPage help', () => {
  it('explains the ontology from the page header', async () => {
    view();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Help: An ontology and its versions' }),
    );
    expect(
      screen.getByRole('dialog', { name: 'An ontology and its versions' }),
    ).toBeInTheDocument();
  });

  it('the term kinds bar shows help for the selected kind', async () => {
    view();
    await screen.findByRole('tree');
    const bar = screen.getByRole('group', { name: 'Term kinds' }).parentElement!;
    expect(within(bar).getByRole('button', { name: 'Help: Classes' })).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Term kinds' })).getByRole('button', {
        name: 'Properties (2)',
      }),
    );
    await userEvent.click(within(bar).getByRole('button', { name: 'Help: Properties' }));
    expect(screen.getByRole('dialog', { name: 'Properties' })).toBeInTheDocument();
  });
});
