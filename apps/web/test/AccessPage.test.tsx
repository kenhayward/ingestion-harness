import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccessToken } from '../src/api/client.js';
import { AccessPage } from '../src/access/AccessPage.js';
import { fakeApi } from './fake-api.js';

const token = (o: Partial<AccessToken> = {}): AccessToken => ({
  id: crypto.randomUUID(),
  label: 'Ken – laptop',
  role: 'user',
  createdAt: '2026-10-12T09:00:00.000Z',
  expiresAt: '2026-11-11T09:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
  status: 'active',
  ...o,
});

const ADMIN = { role: 'admin' as const, label: 'admin', expiresAt: null };
/** The row whose Label cell (first column) is `label`. */
const row = (label: string) => screen.getAllByRole('cell', { name: label })[0]!.closest('tr')!;

describe('AccessPage', () => {
  it('lists tokens with their status', async () => {
    const tokens = [
      token({ label: 'admin', role: 'admin', status: 'current-admin', expiresAt: null }),
      token({ label: 'Ken – laptop' }),
      token({ label: 'old', status: 'revoked', revokedAt: '2026-10-12T10:00:00.000Z' }),
    ];
    render(<AccessPage api={fakeApi({ listTokens: vi.fn(async () => tokens) })} me={ADMIN} />);
    const table = await screen.findByRole('table', { name: 'Access tokens' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Label', 'Role', 'Created', 'Expires', 'Last used', 'Status', '']);
    expect(within(row('admin')).queryAllByRole('button')).toEqual([]);
    expect(within(row('admin')).getByText('current admin')).toBeInTheDocument();
    expect(within(row('Ken – laptop')).getByText('never used')).toBeInTheDocument();
    expect(
      within(row('Ken – laptop'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Revoke', 'Delete']);
    expect(
      within(row('old'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Delete']);
  });

  it('creates a token and shows it only once', async () => {
    const created = token({ label: 'Phone' });
    const createToken = vi.fn(async () => ({ token: 'ih_secret', record: created }));
    const listTokens = vi.fn(async () => [created]);
    render(<AccessPage api={fakeApi({ createToken, listTokens })} me={ADMIN} />);
    await userEvent.type(await screen.findByLabelText('Label'), 'Phone');
    await userEvent.selectOptions(screen.getByLabelText('Expires after'), '90');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(createToken).toHaveBeenCalledWith('Phone', 90);
    const shown = await screen.findByLabelText('New token for Phone');
    expect(shown).toHaveValue('ih_secret');
    expect(shown).toHaveAttribute('readonly');
    expect(screen.getByText('This is the only time it will be shown.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByDisplayValue('ih_secret')).not.toBeInTheDocument();
  });

  it('can create a token that never expires', async () => {
    const createToken = vi.fn(async () => ({ token: 'ih_x', record: token() }));
    render(<AccessPage api={fakeApi({ createToken })} me={ADMIN} />);
    await userEvent.type(await screen.findByLabelText('Label'), 'Kiosk');
    await userEvent.selectOptions(screen.getByLabelText('Expires after'), 'never');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(createToken).toHaveBeenCalledWith('Kiosk', null);
  });

  it('revokes and deletes after confirming', async () => {
    const t = token({ label: 'Phone' });
    const revokeToken = vi.fn(async () => undefined);
    const deleteToken = vi.fn(async () => undefined);
    render(
      <AccessPage
        api={fakeApi({ listTokens: vi.fn(async () => [t]), revokeToken, deleteToken })}
        me={ADMIN}
      />,
    );
    await screen.findByRole('cell', { name: 'Phone' });
    await userEvent.click(within(row('Phone')).getByRole('button', { name: 'Revoke' }));
    expect(revokeToken).not.toHaveBeenCalled();
    await userEvent.click(
      within(row('Phone')).getByRole('button', { name: 'Confirm revoke Phone' }),
    );
    expect(revokeToken).toHaveBeenCalledWith(t.id);
    await userEvent.click(within(row('Phone')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(row('Phone')).getByRole('button', { name: 'Confirm delete Phone' }),
    );
    expect(deleteToken).toHaveBeenCalledWith(t.id);
  });

  it('is for admins only', async () => {
    const listTokens = vi.fn(async () => []);
    render(
      <AccessPage
        api={fakeApi({ listTokens })}
        me={{ role: 'user', label: 'Ken', expiresAt: null }}
      />,
    );
    expect(screen.getByText('Admins only.')).toBeInTheDocument();
    expect(listTokens).not.toHaveBeenCalled();
  });

  it('shows errors', async () => {
    const createToken = vi.fn(async () => {
      throw new Error('label (1-100 chars) and expiresInDays are required');
    });
    render(<AccessPage api={fakeApi({ createToken })} me={ADMIN} />);
    await userEvent.type(await screen.findByLabelText('Label'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('label (1-100 chars)');
  });

  it('explains manual copying when the clipboard is unavailable (plain-HTTP LAN)', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    try {
      const createToken = vi.fn(async () => ({ token: 'ih_secret', record: token() }));
      render(<AccessPage api={fakeApi({ createToken })} me={ADMIN} />);
      await userEvent.type(await screen.findByLabelText('Label'), 'Phone');
      await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
      expect(screen.getByRole('status')).toHaveTextContent(
        'Copying needs HTTPS here: select the token and copy it manually.',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
