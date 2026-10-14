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

function view(role: 'admin' | 'user' = 'user', overrides: Partial<Api> = {}) {
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
  render(<OntologyPage api={api} role={role} ontologyId="pv" pollMs={10} searchDelayMs={0} />);
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
    view('user', {
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

  it('lists imports it could not resolve', async () => {
    view('user', {
      getOntology: vi.fn(async () =>
        ontologyDetail({
          versions: [
            ontologyVersion({
              imports: [
                {
                  iri: 'https://example.org/base',
                  resolution: 'unresolved',
                  ontologyId: null,
                  version: null,
                  reason: null,
                },
              ],
            }),
          ],
        }),
      ),
    });
    expect(
      await screen.findByText('1 imported ontology is not in the library'),
    ).toBeInTheDocument();
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
