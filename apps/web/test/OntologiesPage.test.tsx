import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import { OntologiesPage } from '../src/ontologies/OntologiesPage.js';
import { fakeApi, ontologySummary, ontologyVersion } from './fake-api.js';

function page(
  list = [ontologySummary()],
  role: 'admin' | 'user' = 'admin',
  overrides: Partial<Api> = {},
) {
  const api = fakeApi({ listOntologies: vi.fn(async () => list), ...overrides });
  render(<OntologiesPage api={api} role={role} pollMs={10} />);
  return api;
}

describe('OntologiesPage', () => {
  it('shows each ontology with its kinds, tags and newest version', async () => {
    page([
      ontologySummary({ localOnly: true }),
      ontologySummary({
        id: 'stages',
        label: 'Process stages',
        tags: [],
        latest: ontologyVersion({ status: 'failed', error: 'cannot read stages.ttl as Turtle' }),
      }),
    ]);
    const pv = await screen.findByRole('region', { name: 'Ontology Process validation' });
    expect(within(pv).getByRole('link', { name: 'Process validation' })).toHaveAttribute(
      'href',
      '#/ontologies/pv',
    );
    expect(within(pv).getByText('OWL')).toBeInTheDocument();
    expect(within(pv).getByText('Local only')).toBeInTheDocument();
    expect(within(pv).getByText('industry:pharma')).toBeInTheDocument();
    expect(within(pv).getByText(/3 classes · 2 properties/)).toBeInTheDocument();
    const stages = screen.getByRole('region', { name: 'Ontology Process stages' });
    expect(within(stages).getByText(/Import failed: cannot read stages.ttl/)).toBeInTheDocument();
  });

  it('filters by the search box', async () => {
    page([
      ontologySummary(),
      ontologySummary({ id: 'stages', label: 'Process stages', tags: ['customer:acme'] }),
    ]);
    await screen.findByRole('region', { name: 'Ontology Process stages' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search ontologies' }), 'acme');
    expect(
      screen.queryByRole('region', { name: 'Ontology Process validation' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Ontology Process stages' })).toBeInTheDocument();
  });

  it('offers Import only to admins and explains an empty library', async () => {
    page([], 'user');
    expect(
      await screen.findByText(/No ontologies yet\. An admin imports them\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import ontology' })).not.toBeInTheDocument();
  });

  it('polls while a version is importing', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([ontologySummary({ latest: ontologyVersion({ status: 'parsing' }) })])
      .mockResolvedValue([ontologySummary()]);
    page(undefined, 'admin', { listOntologies: list });
    expect(await screen.findByText('Importing…')).toBeInTheDocument();
    expect(await screen.findByText(/3 classes/)).toBeInTheDocument();
    const calls = list.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(list.mock.calls.length).toBe(calls); // stopped once ready
  });

  it('imports a new ontology, its id made from the name', async () => {
    const api = page([], 'admin', { importOntology: vi.fn(async () => ontologyVersion()) });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    const file = new File(['@prefix x: <y> .'], 'idmp.ttl', { type: 'text/turtle' });
    await userEvent.upload(within(dialog).getByLabelText('Ontology file'), file);
    await userEvent.type(within(dialog).getByLabelText('Name'), 'IDMP O');
    expect(within(dialog).getByLabelText('Id')).toHaveValue('idmp-o');
    await userEvent.type(
      within(dialog).getByLabelText('Tags (comma-separated)'),
      'industry:pharma',
    );
    await userEvent.click(within(dialog).getByLabelText(/Local only/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importOntology).toHaveBeenCalledWith(file, {
        id: 'idmp-o',
        label: 'IDMP O',
        tags: ['industry:pharma'],
        localOnly: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('adds a version to an existing ontology and shows refusals', async () => {
    const api = page([ontologySummary()], 'admin', {
      importOntology: vi.fn(async () => {
        throw new Error('this file is already version 1 of pv');
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.type(within(dialog).getByLabelText('Id'), 'pv');
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Adds version 2 of Process validation.',
    );
    const file = new File(['x'], 'pv.ttl');
    await userEvent.upload(within(dialog).getByLabelText('Ontology file'), file);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already version 1 of pv');
    expect(api.importOntology).toHaveBeenCalledWith(file, { id: 'pv' });
  });
});
