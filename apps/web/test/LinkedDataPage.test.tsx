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
