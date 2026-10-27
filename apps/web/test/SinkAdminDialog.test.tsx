import type { AdminClient, AdminInstance, AuditEntry } from '@ih/bridge-contract';
import type { SinkInfo } from '@ih/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { SinkAdminDialog } from '../src/access/SinkAdminDialog.js';
import { fakeApi } from './fake-api.js';

const ada = { id: 'u1', name: 'Ada Admin' };

const SINK: SinkInfo = {
  id: 'admin-sink',
  name: 'Administered sink',
  status: 'available',
  contractVersion: 3,
  connectionKind: 'shared',
  instances: [],
  destinationFields: [],
  credentialFields: [],
  capabilities: {
    browse: false,
    replace: true,
    withdraw: false,
    readBack: false,
    accepts: ['files'],
    administration: {
      instances: true,
      clients: true,
      instanceFields: [
        { id: 'address', label: 'Address', required: true, hint: 'Where it is reached' },
        { id: 'region', label: 'Region', required: false, hint: null },
      ],
    },
  },
};

const configured: AdminInstance = {
  id: 'sandbox',
  label: 'Sandbox',
  fields: { address: 'https://sandbox.example.test' },
  locked: true,
  createdAt: null,
  createdBy: null,
};
const added: AdminInstance = {
  id: 'north',
  label: 'North',
  fields: { address: 'https://north.example.test' },
  locked: false,
  createdAt: '2026-10-27T09:00:00.000Z',
  createdBy: ada,
};

const client = (over: Partial<AdminClient> = {}): AdminClient => ({
  id: 'c_1',
  name: 'Reports',
  prefix: 'sk_abc',
  instances: ['north'],
  access: 'read',
  locked: false,
  createdAt: '2026-10-27T09:00:00.000Z',
  createdBy: ada,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  ...over,
});
const TOKEN = 'sk_abc_the-secret-token-value';

const entry = (subject: string): AuditEntry => ({
  at: '2026-10-27T09:00:00.000Z',
  actor: ada,
  action: 'instance_added',
  subject,
  detail: `Added ${subject}`,
});

function dialog(overrides = {}) {
  const api = fakeApi({
    listSinkInstances: vi.fn(async () => [configured, added]),
    listSinkClients: vi.fn(async () => [
      client(),
      client({ id: 'cfg', name: 'Configured caller', prefix: null, locked: true }),
    ]),
    ...overrides,
  });
  const onClose = vi.fn();
  render(<SinkAdminDialog api={api} sink={SINK} onClose={onClose} />);
  return { api, onClose };
}

const tab = (name: string) => userEvent.click(screen.getByRole('button', { name }));
const row = (name: string) => screen.findByRole('row', { name: new RegExp(name) });

describe('SinkAdminDialog: instances', () => {
  it('lists instances; a locked one is marked and has no actions', async () => {
    dialog();
    const locked = await row('Sandbox');
    expect(locked).toHaveTextContent('Locked');
    expect(within(locked).queryByRole('button')).toBeNull();
    const own = await row('North');
    expect(within(own).getByRole('button', { name: 'Rename North' })).toBeEnabled();
    expect(within(own).getByRole('button', { name: 'Remove North' })).toBeEnabled();
  });

  it("adds an instance from the sink's declared fields, with their hints", async () => {
    const { api } = dialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Add instance' }));
    const form = screen.getByRole('form', { name: 'Add instance' });
    expect(within(form).getByText('Where it is reached')).toBeInTheDocument();
    const address = within(form).getByLabelText(/^Address/);
    expect(address).toBeRequired();
    expect(address).toHaveAttribute('type', 'text');
    expect(within(form).getByLabelText(/^Region/)).not.toBeRequired();
    await userEvent.type(within(form).getByLabelText(/^Id/), 'south');
    await userEvent.type(within(form).getByLabelText(/^Label/), 'South');
    await userEvent.type(address, 'https://south.example.test');
    await userEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(api.addSinkInstance).toHaveBeenCalledWith('admin-sink', {
      id: 'south',
      label: 'South',
      fields: { address: 'https://south.example.test' },
    });
  });

  it('renames an instance', async () => {
    const { api } = dialog();
    await userEvent.click(within(await row('North')).getByRole('button', { name: 'Rename North' }));
    const input = screen.getByRole('textbox', { name: 'New label for North' });
    await userEvent.clear(input);
    await userEvent.type(input, 'North office');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.renameSinkInstance).toHaveBeenCalledWith('admin-sink', 'north', 'North office');
  });

  it('removes an instance only after a confirmation', async () => {
    const { api } = dialog();
    await userEvent.click(within(await row('North')).getByRole('button', { name: 'Remove North' }));
    expect(api.removeSinkInstance).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm remove North' }));
    expect(api.removeSinkInstance).toHaveBeenCalledWith('admin-sink', 'north');
  });

  it("shows the sink's refusal", async () => {
    dialog({
      removeSinkInstance: vi.fn(async () => {
        throw new ApiError('north is in use elsewhere', 409, { code: 'locked' });
      }),
    });
    await userEvent.click(within(await row('North')).getByRole('button', { name: 'Remove North' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm remove North' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('north is in use elsewhere');
  });
});

describe('SinkAdminDialog: clients', () => {
  it('lists clients with prefix, access, expiry and state; a locked one has no Revoke', async () => {
    dialog();
    await tab('Clients');
    const own = await row('Reports');
    expect(own).toHaveTextContent('sk_abc');
    expect(own).toHaveTextContent('Read');
    expect(own).toHaveTextContent('Never');
    expect(own).toHaveTextContent('Active');
    expect(within(own).getByRole('button', { name: 'Revoke Reports' })).toBeEnabled();
    const locked = await row('Configured caller');
    expect(locked).toHaveTextContent('Locked');
    expect(within(locked).queryByRole('button')).toBeNull();
  });

  it('shows a revoked client as revoked, with nothing to do', async () => {
    dialog({
      listSinkClients: vi.fn(async () => [client({ revokedAt: '2026-10-27T10:00:00.000Z' })]),
    });
    await tab('Clients');
    const r = await row('Reports');
    expect(r).toHaveTextContent('Revoked');
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('issues a client and shows its token once, with Copy and a warning', async () => {
    const { api } = dialog({
      issueSinkClient: vi.fn(async () => ({ client: client({ id: 'c_2' }), token: TOKEN })),
    });
    await tab('Clients');
    await userEvent.click(await screen.findByRole('button', { name: 'Issue client' }));
    const form = screen.getByRole('form', { name: 'Issue client' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Nightly export');
    await userEvent.click(within(form).getByRole('radio', { name: 'Chosen instances' }));
    await userEvent.click(within(form).getByRole('checkbox', { name: 'North' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Read and write' }));
    await userEvent.click(within(form).getByRole('button', { name: '90 days' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Issue' }));
    expect(api.issueSinkClient).toHaveBeenCalledWith('admin-sink', {
      name: 'Nightly export',
      instances: ['north'],
      access: 'read_write',
      expiresInDays: 90,
    });
    const panel = await screen.findByRole('region', { name: 'New client token' });
    expect(within(panel).getByLabelText('Token')).toHaveValue(TOKEN);
    expect(panel).toHaveTextContent(/will not be shown again/);
    expect(within(panel).getByRole('button', { name: 'Copy token' })).toBeEnabled();
    await userEvent.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region', { name: 'New client token' })).toBeNull();
    expect(screen.queryByDisplayValue(TOKEN)).toBeNull();
  });

  it('issues for every instance by default, with no expiry when asked', async () => {
    const { api } = dialog({
      issueSinkClient: vi.fn(async () => ({ client: client(), token: TOKEN })),
    });
    await tab('Clients');
    await userEvent.click(await screen.findByRole('button', { name: 'Issue client' }));
    const form = screen.getByRole('form', { name: 'Issue client' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Everything');
    await userEvent.click(within(form).getByRole('button', { name: 'No expiry' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Issue' }));
    expect(api.issueSinkClient).toHaveBeenCalledWith('admin-sink', {
      name: 'Everything',
      instances: 'all',
      access: 'read',
      expiresInDays: null,
    });
  });

  it('the token is gone once the dialog closes', async () => {
    const { onClose } = dialog({
      issueSinkClient: vi.fn(async () => ({ client: client(), token: TOKEN })),
    });
    await tab('Clients');
    await userEvent.click(await screen.findByRole('button', { name: 'Issue client' }));
    const form = screen.getByRole('form', { name: 'Issue client' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Once');
    await userEvent.click(within(form).getByRole('button', { name: 'Issue' }));
    await screen.findByRole('region', { name: 'New client token' });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('revokes a client only after a confirmation', async () => {
    const { api } = dialog({
      revokeSinkClient: vi.fn(async () => client({ revokedAt: '2026-10-27T10:00:00.000Z' })),
    });
    await tab('Clients');
    await userEvent.click(
      within(await row('Reports')).getByRole('button', { name: 'Revoke Reports' }),
    );
    expect(api.revokeSinkClient).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm revoke Reports' }));
    expect(api.revokeSinkClient).toHaveBeenCalledWith('admin-sink', 'c_1');
  });
});

describe('SinkAdminDialog: audit log', () => {
  it('lists the newest entries, then loads more by the cursor', async () => {
    const listSinkAudit = vi.fn(async (_sinkId: string, cursor: string | null) =>
      cursor === null
        ? { entries: [entry('north')], nextCursor: 'page-2' }
        : { entries: [entry('south')], nextCursor: null },
    );
    dialog({ listSinkAudit });
    await tab('Audit log');
    expect(await screen.findByText('Added north')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Added south')).toBeInTheDocument();
    expect(screen.getByText('Added north')).toBeInTheDocument();
    expect(listSinkAudit).toHaveBeenLastCalledWith('admin-sink', 'page-2');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  });
});

describe('SinkAdminDialog: what the sink offers', () => {
  it('shows only the sections the sink declares', async () => {
    const api = fakeApi({ listSinkClients: vi.fn(async () => []) });
    const clientsOnly: SinkInfo = {
      ...SINK,
      capabilities: {
        ...SINK.capabilities,
        administration: { instances: false, clients: true, instanceFields: [] },
      },
    };
    render(<SinkAdminDialog api={api} sink={clientsOnly} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Instances' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Issue client' })).toBeInTheDocument();
    // Its instances are not administered: the issue form picks from those it describes.
    expect(api.listSinkInstances).not.toHaveBeenCalled();
  });
});
