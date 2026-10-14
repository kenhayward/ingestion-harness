import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { LinkedDataView } from '@ih/shared';
import type { Me } from '../src/api/client.js';
import { LinkedDataPage } from '../src/linked-data/LinkedDataPage.js';
import { fakeApi } from './fake-api.js';

const admin: Me = { role: 'admin', label: 'admin', expiresAt: null };

const view = (over: Partial<LinkedDataView> = {}): LinkedDataView => ({
  settings: {
    customerName: '',
    customerSlug: null,
    baseIri: null,
    updatedBy: null,
    updatedAt: null,
  },
  effectiveBase: null,
  rdfPublished: 0,
  graphs: { published: 0, lastPublishedAt: null, endpoint: null },
  endpoint: null,
  withdrawals: { queued: 0, running: 0, failed: 0 },
  history: [],
  ...over,
});

const acme = view({
  settings: {
    customerName: 'Acme',
    customerSlug: 'acme',
    baseIri: null,
    updatedBy: 'admin',
    updatedAt: '2026-10-14T10:00:00.000Z',
  },
  effectiveBase: 'https://id.stocks-hayward.com/acme/',
  rdfPublished: 3,
  history: [
    {
      fromBase: null,
      toBase: 'https://id.stocks-hayward.com/acme/',
      changedBy: 'admin',
      changedAt: '2026-10-14T10:00:00.000Z',
      rdfPublished: 0,
    },
  ],
});

function setup(initial: LinkedDataView, me: Me = admin) {
  const api = fakeApi({
    getLinkedData: vi.fn(async () => initial),
    saveLinkedData: vi.fn(async () => initial),
  });
  render(<LinkedDataPage api={api} me={me} />);
  return api;
}

describe('LinkedDataPage', () => {
  it('is for admins only', () => {
    const api = setup(view(), { role: 'user', label: 'u', expiresAt: null });
    expect(screen.getByText('Admins only.')).toBeTruthy();
    expect(api.getLinkedData).not.toHaveBeenCalled();
  });

  it('fills the slug from the name, previews IRIs and saves', async () => {
    const api = setup(view());
    await userEvent.type(await screen.findByLabelText('Customer name'), 'Acme Pharma Ltd');
    expect(screen.getByLabelText('Customer id')).toHaveValue('acme-pharma-ltd');
    expect(
      screen.getByText('https://id.stocks-hayward.com/acme-pharma-ltd/doc/{sha256}'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.saveLinkedData).toHaveBeenCalledWith({
      customerName: 'Acme Pharma Ltd',
      customerSlug: 'acme-pharma-ltd',
      baseIri: null,
    });
  });

  it('refuses an unusable base IRI and warns about environment words', async () => {
    setup(acme);
    const base = await screen.findByLabelText('Base IRI (optional)');
    await userEvent.type(base, 'http://data.acme.example/');
    expect(screen.getByText('the base IRI must use https')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(base);
    await userEvent.type(base, 'https://staging.acme.example/');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByText(/Avoid “staging”/)).toBeTruthy();
  });

  it('asks for confirmation before changing the base once RDF was published', async () => {
    const api = setup(acme);
    await userEvent.type(
      await screen.findByLabelText('Base IRI (optional)'),
      'https://data.acme.example/',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the base IRI?' });
    expect(dialog).toHaveTextContent('3 RDF outputs were published under');
    expect(api.saveLinkedData).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change the base' }));
    expect(api.saveLinkedData).toHaveBeenCalledWith({
      customerName: 'Acme',
      customerSlug: 'acme',
      baseIri: 'https://data.acme.example/',
      confirm: 'https://data.acme.example/',
    });
  });

  it('lists the published count and the history of the base', async () => {
    setup(acme);
    expect(await screen.findByText(/3 RDF outputs published/)).toBeTruthy();
    const history = screen.getByRole('table', { name: 'Base IRI history' });
    expect(history).toHaveTextContent('https://id.stocks-hayward.com/acme/');
  });
});

describe('LinkedDataPage published graphs (ADR 0011 step 6)', () => {
  it('counts the graphs under the base and says whether they reach Fuseki', async () => {
    setup({
      ...acme,
      graphs: { published: 4, lastPublishedAt: '2026-10-14T11:00:00.000Z', endpoint: true },
    });
    expect(await screen.findByText(/4 graphs published under/)).toBeInTheDocument();
    expect(screen.getByText(/Graphs go to the triple store \(Fuseki\)/)).toBeInTheDocument();
  });

  it('says when graphs go to S3 only', async () => {
    setup({
      ...acme,
      graphs: { published: 1, lastPublishedAt: '2026-10-14T11:00:00.000Z', endpoint: false },
    });
    expect(await screen.findByText(/1 graph published under/)).toBeInTheDocument();
    expect(screen.getByText(/No triple store is configured/)).toBeInTheDocument();
  });
});

describe('LinkedDataPage consumer access and withdrawals (ADR 0011 step 7)', () => {
  it('shows the SPARQL endpoint and its read-only user, never a password', async () => {
    setup({
      ...acme,
      endpoint: {
        sparql: 'https://sparql.acme.example/ct/sparql',
        get: 'https://sparql.acme.example/ct/get',
        user: 'ct-reader',
      },
    });
    expect(await screen.findByText('https://sparql.acme.example/ct/sparql')).toBeInTheDocument();
    expect(screen.getByText('ct-reader')).toBeInTheDocument();
    expect(screen.getByText(/find entities by their values/i)).toBeInTheDocument();
  });

  it('says when withdrawals are pending or failed', async () => {
    setup({ ...acme, withdrawals: { queued: 2, running: 0, failed: 1 } });
    expect(await screen.findByText(/2 withdrawals or republishes waiting/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 failed');
  });
});
