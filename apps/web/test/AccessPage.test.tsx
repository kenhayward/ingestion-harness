import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessToken } from '../src/api/client.js';
import { AccessPage } from '../src/access/AccessPage.js';
import { fakeApi } from './fake-api.js';

const DAY = 86_400_000;
const token = (o: Partial<AccessToken> = {}): AccessToken => ({
  id: crypto.randomUUID(),
  label: 'Ken – laptop',
  role: 'user',
  createdAt: new Date(Date.now() - 10 * DAY).toISOString(),
  expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
  revokedAt: null,
  lastUsedAt: null,
  status: 'active',
  ...o,
});

const ADMIN = { role: 'admin' as const, label: 'admin', expiresAt: null };
/** The row of the token labelled `label` (its name starts with the label cell). */
const rowName = (label: string) => new RegExp(`^${label}\\b`);
const row = (label: string) => screen.getByRole('row', { name: rowName(label) });

const four = () => [
  token({ label: 'admin', role: 'admin', status: 'current-admin', expiresAt: null }),
  token({ label: 'Phone', expiresAt: new Date(Date.now() + 2 * DAY + 3600_000).toISOString() }),
  token({
    label: 'Contractor',
    status: 'expired',
    expiresAt: new Date(Date.now() - 3 * DAY).toISOString(),
  }),
  token({ label: 'Demo', status: 'revoked', revokedAt: new Date().toISOString() }),
];

afterEach(() => vi.unstubAllGlobals());

describe('AccessPage', () => {
  it('has a header, the issue form and the admin-token note', async () => {
    render(<AccessPage api={fakeApi()} me={ADMIN} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Access' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Issue a token' })).toBeInTheDocument();
    expect(screen.getByText('The admin token rotates')).toBeInTheDocument();
    const expiry = screen.getByRole('group', { name: 'Expires after' });
    expect(within(expiry).getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('lists tokens with role, expiry, status and the right actions', async () => {
    render(<AccessPage api={fakeApi({ listTokens: vi.fn(async () => four()) })} me={ADMIN} />);
    await screen.findByText('Phone');
    expect(within(row('admin')).queryAllByRole('button')).toEqual([]);
    expect(within(row('admin')).getByText('Rotates on restart')).toBeInTheDocument();
    expect(within(row('admin')).getByText('Current admin')).toBeInTheDocument();
    expect(within(row('Phone')).getByText('in 2 days')).toBeInTheDocument();
    expect(within(row('Phone')).getByText('Active')).toBeInTheDocument();
    expect(within(row('Phone')).getByText('never used')).toBeInTheDocument();
    expect(within(row('Phone')).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(within(row('Phone')).getByRole('button', { name: 'Delete Phone' })).toBeInTheDocument();
    expect(within(row('Contractor')).getByText('3 days ago')).toBeInTheDocument();
    expect(within(row('Contractor')).queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(within(row('Demo')).getByText('Revoked')).toBeInTheDocument();
  });

  it('filters by status with counts, and says when a view is empty', async () => {
    render(<AccessPage api={fakeApi({ listTokens: vi.fn(async () => four()) })} me={ADMIN} />);
    await screen.findByText('Phone');
    const chips = screen.getByRole('group', { name: 'Filter tokens by status' });
    expect(within(chips).getByRole('button', { name: 'All 4' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(chips).getByRole('button', { name: 'Active 2' }));
    expect(screen.getByRole('row', { name: rowName('admin') })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: rowName('Demo') })).not.toBeInTheDocument();
    await userEvent.click(within(chips).getByRole('button', { name: 'Revoked 1' }));
    expect(screen.getByRole('row', { name: rowName('Demo') })).toBeInTheDocument();
  });

  it('combines the chip with the top-bar search', async () => {
    render(
      <AccessPage
        api={fakeApi({ listTokens: vi.fn(async () => four()) })}
        me={ADMIN}
        query="phone"
      />,
    );
    await screen.findByText('Phone');
    await userEvent.click(screen.getByRole('button', { name: 'Revoked 1' }));
    expect(screen.getByText('No tokens match “phone”.')).toBeInTheDocument();
  });

  it('says when a chip has no tokens', async () => {
    render(
      <AccessPage
        api={fakeApi({ listTokens: vi.fn(async () => [token({ label: 'Phone' })]) })}
        me={ADMIN}
      />,
    );
    await screen.findByText('Phone');
    await userEvent.click(screen.getByRole('button', { name: 'Expired 0' }));
    expect(screen.getByText('No tokens in this view.')).toBeInTheDocument();
  });

  it('creates a token with a preset expiry and shows it only once', async () => {
    const created = token({ label: 'Phone' });
    const createToken = vi.fn(async () => ({ token: 'ih_secret', record: created }));
    render(
      <AccessPage
        api={fakeApi({ createToken, listTokens: vi.fn(async () => [created]) })}
        me={ADMIN}
      />,
    );
    await userEvent.type(screen.getByLabelText('Label'), 'Phone');
    await userEvent.click(screen.getByRole('button', { name: '90 days' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(createToken).toHaveBeenCalledWith('Phone', 90);
    const panel = await screen.findByRole('region', { name: 'New token' });
    expect(within(panel).getByText('Token created for “Phone”')).toBeInTheDocument();
    expect(
      within(panel).getByText('Copy it now — this is the only time it will be shown.'),
    ).toBeInTheDocument();
    const shown = within(panel).getByLabelText('New token for Phone');
    expect(shown).toHaveValue('ih_secret');
    expect(shown).toHaveAttribute('readonly');
    await userEvent.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(screen.queryByDisplayValue('ih_secret')).not.toBeInTheDocument();
  });

  it('can create a token that never expires', async () => {
    const createToken = vi.fn(async () => ({ token: 'ih_x', record: token() }));
    render(<AccessPage api={fakeApi({ createToken })} me={ADMIN} />);
    await userEvent.type(screen.getByLabelText('Label'), 'Kiosk');
    await userEvent.click(screen.getByRole('button', { name: 'Never' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(createToken).toHaveBeenCalledWith('Kiosk', null);
  });

  it('copies the token, saying so', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const createToken = vi.fn(async () => ({ token: 'ih_secret', record: token() }));
    render(<AccessPage api={fakeApi({ createToken })} me={ADMIN} />);
    await userEvent.type(screen.getByLabelText('Label'), 'Phone');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('ih_secret');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('explains a failed copy and never claims it copied', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    const createToken = vi.fn(async () => ({ token: 'ih_secret', record: token() }));
    render(<AccessPage api={fakeApi({ createToken })} me={ADMIN} />);
    await userEvent.type(screen.getByLabelText('Label'), 'Phone');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Copy failed: select the token and copy it manually.',
    );
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });

  it('explains manual copying when the clipboard is unavailable (plain-HTTP LAN)', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const createToken = vi.fn(async () => ({ token: 'ih_secret', record: token() }));
    render(<AccessPage api={fakeApi({ createToken })} me={ADMIN} />);
    await userEvent.type(screen.getByLabelText('Label'), 'Phone');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Copying needs HTTPS here: select the token and copy it manually.',
    );
  });

  it('revokes only after confirming; Keep sends nothing', async () => {
    const t = token({ label: 'Phone' });
    const revokeToken = vi.fn(async () => undefined);
    render(
      <AccessPage api={fakeApi({ listTokens: vi.fn(async () => [t]), revokeToken })} me={ADMIN} />,
    );
    await screen.findByText('Phone');
    await userEvent.click(within(row('Phone')).getByRole('button', { name: 'Revoke' }));
    expect(within(row('Phone')).getByText('Revoke? Its sessions end now.')).toBeInTheDocument();
    await userEvent.click(within(row('Phone')).getByRole('button', { name: 'Keep' }));
    expect(revokeToken).not.toHaveBeenCalled();
    await userEvent.click(within(row('Phone')).getByRole('button', { name: 'Revoke' }));
    const confirm = within(row('Phone')).getByRole('button', { name: 'Revoke now' });
    expect(confirm).toHaveFocus();
    await userEvent.click(confirm);
    expect(revokeToken).toHaveBeenCalledWith(t.id);
  });

  it('deletes only after confirming', async () => {
    const t = token({ label: 'Phone' });
    const deleteToken = vi.fn(async () => undefined);
    render(
      <AccessPage api={fakeApi({ listTokens: vi.fn(async () => [t]), deleteToken })} me={ADMIN} />,
    );
    await screen.findByText('Phone');
    await userEvent.click(within(row('Phone')).getByRole('button', { name: 'Delete Phone' }));
    expect(within(row('Phone')).getByText('Delete this token record?')).toBeInTheDocument();
    await userEvent.click(within(row('Phone')).getByRole('button', { name: 'Delete' }));
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
    await userEvent.type(screen.getByLabelText('Label'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('label (1-100 chars)');
  });
});
