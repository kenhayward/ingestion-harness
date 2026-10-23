import type { SinkInfo, PublishTargetView } from '@ih/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AdminDialog } from '../src/access/AdminDialog.js';
import { PublishedOutputsPage } from '../src/access/PublishedOutputsPage.js';
import { fakeApi } from './fake-api.js';

const admin = {
  role: 'admin' as const,
  label: 'Ken',
  email: null,
  mustChangePassword: false,
  userId: 'u-test',
};

const NO_USE = {
  publishedVersions: 0,
  documentTypes: [],
  deliveredOutputs: 0,
  consumers: 0,
  pendingJobs: 0,
};

function target(over: Partial<PublishTargetView> = {}): PublishTargetView {
  return {
    id: 'default',
    label: 'Default',
    kind: 'internal',
    sinkId: 's3',
    instanceId: null,
    destination: { bucket: 'ingest-published', prefix: '', layout: 'files' },
    onBridge: true,
    bucket: 'ingest-published',
    prefix: '',
    layout: 'files',
    sinkName: null,
    deliverOnly: false,
    endpoint: null,
    connectionId: null,
    connection: null,
    sse: 'none',
    kmsKeyId: null,
    storageClass: null,
    source: 'env',
    editedAt: null,
    updatedBy: null,
    createdAt: '2026-10-16T10:00:00.000Z',
    usage: { ...NO_USE, publishedVersions: 2, documentTypes: ['invoice', 'po'] },
    ...over,
  };
}

const external = (over: Partial<PublishTargetView> = {}) =>
  target({
    id: 'finance-lake',
    label: 'Finance lake',
    kind: 'external',
    bucket: 'finance-bucket',
    prefix: 'ingest/',
    connectionId: 'finance-account',
    connection: {
      id: 'finance-account',
      name: 'Finance account',
      status: 'ok',
      statusReason: null,
    },
    source: 'ui',
    updatedBy: 'Sam',
    usage: NO_USE,
    ...over,
  });

const tripleStore = (over: Partial<PublishTargetView> = {}) =>
  target({
    id: 'rdf-default',
    label: 'Triple store',
    kind: 'rdf',
    bucket: 'ct',
    prefix: '',
    endpoint: 'http://fuseki:3030',
    connectionId: 'rdf-default',
    connection: { id: 'rdf-default', name: 'Triple store', status: 'ok', statusReason: null },
    usage: NO_USE,
    ...over,
  });

const FAKE_SINK: SinkInfo = {
  id: 'fake',
  name: 'Fake sink',
  status: 'available',
  contractVersion: 1,
  connectionKind: 'shared',
  instances: [],
  destinationFields: [
    {
      id: 'space',
      label: 'Space',
      kind: 'fixed',
      required: true,
      overridable: false,
      browse: true,
    },
    {
      id: 'name',
      label: 'Name',
      kind: 'pattern',
      required: true,
      overridable: true,
      browse: false,
    },
  ],
  credentialFields: [{ id: 'token', label: 'Token', secret: true }],
  capabilities: {
    browse: true,
    replace: true,
    withdraw: false,
    readBack: false,
    accepts: ['files', 'data'],
  },
};
const S3_SINK: SinkInfo = {
  ...FAKE_SINK,
  id: 's3',
  name: 'S3',
  destinationFields: [],
  capabilities: {
    browse: false,
    replace: true,
    withdraw: true,
    readBack: true,
    accepts: ['files'],
  },
};

function sinkTarget(over: Partial<PublishTargetView> = {}): PublishTargetView {
  return target({
    id: 'fake-target',
    label: 'Fake target',
    kind: 'sink',
    sinkId: 'fake',
    sinkName: 'Fake sink',
    deliverOnly: true,
    destination: { space: 'reports', name: '{source.stem}' },
    bucket: null,
    prefix: null,
    layout: null,
    sse: null,
    connectionId: 'fake-account',
    usage: NO_USE,
    ...over,
  });
}

function page(targets: PublishTargetView[] = [target(), external()], overrides = {}) {
  const api = fakeApi({ listPublishTargets: vi.fn(async () => targets), ...overrides });
  render(<PublishedOutputsPage api={api} me={admin} />);
  return api;
}

const row = (label: string) => screen.findByRole('region', { name: `Target ${label}` });
const open = async (label: string) => {
  const r = await row(label);
  await userEvent.click(within(r).getByRole('button', { name: new RegExp(label) }));
  return r;
};

describe('PublishedOutputsPage', () => {
  it('is for admins only', () => {
    const api = fakeApi();
    render(<PublishedOutputsPage api={api} me={{ ...admin, role: 'designer' }} />);
    expect(screen.getByText('Admins only.')).toBeInTheDocument();
    expect(api.listPublishTargets).not.toHaveBeenCalled();
  });

  it('lists collapsed rows with kind, bucket, usage and where each came from', async () => {
    page();
    const def = await row('Default');
    expect(def).toHaveTextContent('default');
    expect(def).toHaveTextContent('Internal');
    expect(def).toHaveTextContent('ingest-published');
    expect(def).toHaveTextContent('used by 2 document types');
    expect(def).toHaveTextContent('from .env');
    const fin = await row('Finance lake');
    expect(fin).toHaveTextContent('External');
    expect(fin).toHaveTextContent('finance-bucket/ingest/');
    expect(fin).toHaveTextContent('used by 0 document types');
    expect(fin).toHaveTextContent('added here by Sam');
    expect(within(fin).queryByLabelText('Label')).toBeNull();
  });

  it('shows a locked field as read-only while the target is in use', async () => {
    page([external({ usage: { ...NO_USE, publishedVersions: 1, documentTypes: ['po'] } })]);
    const r = await open('Finance lake');
    expect(within(r).getByLabelText('Bucket')).toHaveAttribute('readonly');
    expect(within(r).getByLabelText('Prefix')).toHaveAttribute('readonly');
    expect(within(r).getByLabelText('Label')).not.toHaveAttribute('readonly');
    expect(within(r).getByLabelText('Connection')).not.toBeDisabled();
    expect(r).toHaveTextContent('In use: add a new target to move');
  });

  it('leaves the fields editable when nothing uses the target', async () => {
    page([external()]);
    const r = await open('Finance lake');
    expect(within(r).getByLabelText('Bucket')).not.toHaveAttribute('readonly');
    expect(r).not.toHaveTextContent('In use: add a new target to move');
  });

  it('shows the connection an external target uses, never a credential field', async () => {
    page([
      target(),
      external({
        connection: {
          id: 'finance-account',
          name: 'Finance account',
          status: 'needs_attention',
          statusReason: 'access denied',
        },
      }),
    ]);
    const def = await open('Default');
    expect(within(def).queryByLabelText('Connection')).toBeNull();
    const fin = await open('Finance lake');
    expect(within(fin).getByLabelText('Connection')).toHaveValue('finance-account');
    expect(fin).toHaveTextContent('Needs attention: access denied');
    for (const field of ['Region', 'Endpoint', 'Access key id', 'Secret access key']) {
      expect(within(fin).queryByLabelText(field)).toBeNull();
    }
    expect(fin).not.toHaveTextContent('Set secret');
  });

  it('says when an external target has no connection yet', async () => {
    page([external({ connectionId: null, connection: null })]);
    const fin = await open('Finance lake');
    expect(fin).toHaveTextContent('No connection: choose one, or add it under Manage connections');
  });

  it('saves changed fields, and a new connection', async () => {
    const api = page([external()], {
      updatePublishTarget: vi.fn(async () => external({ label: 'Finance' })),
      listSharedConnections: vi.fn(async () => [
        { id: 'finance-account', name: 'Finance account', status: 'ok', statusReason: null },
        { id: 'finance-2026', name: 'Finance (2026 keys)', status: 'ok', statusReason: null },
      ]),
    });
    const r = await open('Finance lake');
    const label = within(r).getByLabelText('Label');
    await userEvent.clear(label);
    await userEvent.type(label, 'Finance');
    await userEvent.selectOptions(
      await within(r).findByRole('combobox', { name: 'Connection' }),
      'Finance (2026 keys) (OK)',
    );
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updatePublishTarget).toHaveBeenCalledWith('finance-lake', {
        label: 'Finance',
        connectionId: 'finance-2026',
      }),
    );
  });

  it('clears the old test result after saving', async () => {
    page([external()], {
      updatePublishTarget: vi.fn(async () => external()),
      testPublishTarget: vi.fn(async () => ({ ok: true, step: null, message: 'fine' })),
    });
    const r = await open('Finance lake');
    await userEvent.click(within(r).getByRole('button', { name: 'Test connection' }));
    expect(await within(r).findByRole('status')).toBeInTheDocument();
    await userEvent.type(within(r).getByLabelText('Label'), ' 2');
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(r).queryByRole('status')).toBeNull());
  });

  it('says what holds a target, naming only the non-zero parts', async () => {
    page([
      target({
        usage: {
          publishedVersions: 2,
          documentTypes: ['invoice', 'po'],
          deliveredOutputs: 14,
          consumers: 1,
          pendingJobs: 0,
        },
      }),
      external({ usage: { ...NO_USE, deliveredOutputs: 3 } }),
    ]);
    expect(await row('Default')).toHaveTextContent(
      'used by 2 document types · 14 delivered outputs · 1 S3 key consumer',
    );
    const fin = await row('Finance lake');
    expect(fin).toHaveTextContent('used by 3 delivered outputs');
    expect(fin).not.toHaveTextContent('document types');
  });

  it('counts withdrawals still to run', async () => {
    page([external({ usage: { ...NO_USE, pendingJobs: 2 } })]);
    expect(await row('Finance lake')).toHaveTextContent('used by 2 pending withdrawals');
  });

  it('says who edited a target added here, once edited', async () => {
    page([
      external(),
      external({
        id: 'archive',
        label: 'Archive',
        updatedBy: 'Alex',
        editedAt: '2026-10-17T09:00:00.000Z',
      }),
    ]);
    expect(await row('Finance lake')).toHaveTextContent('added here by Sam');
    const archive = await row('Archive');
    expect(archive).toHaveTextContent('edited by Alex');
    expect(archive).not.toHaveTextContent('added here');
  });

  it('clears the storage class and the KMS key with null', async () => {
    const stored = external({ sse: 'aws:kms', kmsKeyId: 'key-1', storageClass: 'STANDARD_IA' });
    const api = page([stored], { updatePublishTarget: vi.fn(async () => stored) });
    const r = await open('Finance lake');
    await userEvent.selectOptions(within(r).getByLabelText('Storage class'), 'Bucket default');
    await userEvent.clear(within(r).getByLabelText('KMS key id'));
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updatePublishTarget).toHaveBeenCalledWith('finance-lake', {
        kmsKeyId: null,
        storageClass: null,
      }),
    );
  });

  it('drops the KMS key when encryption leaves KMS', async () => {
    const stored = external({ sse: 'aws:kms', kmsKeyId: 'key-1' });
    const api = page([stored], { updatePublishTarget: vi.fn(async () => stored) });
    const r = await open('Finance lake');
    await userEvent.selectOptions(within(r).getByLabelText('Server-side encryption'), 'AES256');
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updatePublishTarget).toHaveBeenCalledWith('finance-lake', {
        sse: 'AES256',
        kmsKeyId: null,
      }),
    );
  });

  it('shows why Remove is disabled', async () => {
    page([external({ usage: { ...NO_USE, consumers: 1 } })]);
    const r = await open('Finance lake');
    expect(within(r).getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(r).toHaveTextContent('In use: a recipe version, output, key or withdrawal names it');
  });

  it('shows the failing step of a connection test', async () => {
    const api = page([external()], {
      testPublishTarget: vi.fn(async () => ({
        ok: false,
        step: 'write' as const,
        message: 'access denied',
      })),
    });
    const r = await open('Finance lake');
    await userEvent.click(within(r).getByRole('button', { name: 'Test connection' }));
    expect(await within(r).findByRole('alert')).toHaveTextContent('write');
    expect(within(r).getByRole('alert')).toHaveTextContent('access denied');
    expect(api.testPublishTarget).toHaveBeenCalledWith({ id: 'finance-lake' });
  });

  it('says a connection test passed', async () => {
    page([external()], {
      testPublishTarget: vi.fn(async () => ({
        ok: true,
        step: null,
        message: 'Wrote, read and deleted a file.',
      })),
    });
    const r = await open('Finance lake');
    await userEvent.click(within(r).getByRole('button', { name: 'Test connection' }));
    expect(await within(r).findByRole('status')).toHaveTextContent('Wrote, read and deleted');
  });

  it('removes after a confirm, never offers it for default, disables it in use', async () => {
    const busyTarget = external({ id: 'busy', label: 'Busy', usage: { ...NO_USE, consumers: 1 } });
    const api = page([target(), external(), busyTarget], {
      deletePublishTarget: vi.fn(async () => undefined),
    });
    const def = await open('Default');
    expect(within(def).queryByRole('button', { name: 'Remove' })).toBeNull();

    const busy = await open('Busy');
    expect(within(busy).getByRole('button', { name: 'Remove' })).toBeDisabled();

    const r = await open('Finance lake');
    await userEvent.click(within(r).getByRole('button', { name: 'Remove' }));
    expect(api.deletePublishTarget).not.toHaveBeenCalled();
    await userEvent.click(within(r).getByRole('button', { name: 'Confirm remove Finance lake' }));
    await waitFor(() => expect(api.deletePublishTarget).toHaveBeenCalledWith('finance-lake'));
  });

  it('adds an internal target', async () => {
    const api = page([target()], { createPublishTarget: vi.fn(async () => external()) });
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add publishing target' });
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Archive 2026');
    expect(within(dialog).getByLabelText('Id')).toHaveValue('archive-2026');
    expect(dialog).toHaveTextContent('Use the same id on every deployment for the same recipient');
    expect(within(dialog).queryByLabelText('Region')).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Bucket'), 'archive-bucket');
    await userEvent.type(within(dialog).getByLabelText('Prefix'), 'out');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(api.createPublishTarget).toHaveBeenCalledWith({
        id: 'archive-2026',
        label: 'Archive 2026',
        layout: 'files',
        kind: 'internal',
        bucket: 'archive-bucket',
        prefix: 'out',
      }),
    );
  });

  it('adds an archive: Layout Archive (whole package)', async () => {
    const api = page([target()], { createPublishTarget: vi.fn(async () => external()) });
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add publishing target' });
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Keep');
    await userEvent.type(within(dialog).getByLabelText('Bucket'), 'keep-bucket');
    await userEvent.selectOptions(within(dialog).getByLabelText('Layout'), 'package');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(api.createPublishTarget).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'keep', layout: 'package' }),
      ),
    );
  });

  it('shows an archive on its row, and locks its layout while in use', async () => {
    page([
      external({
        layout: 'package',
        usage: { ...NO_USE, publishedVersions: 1, documentTypes: ['po'] },
      }),
    ]);
    expect(await row('Finance lake')).toHaveTextContent('Archive');
    const r = await open('Finance lake');
    expect(within(r).getByLabelText('Layout')).toBeDisabled();
    expect(within(r).getByLabelText('Layout')).toHaveValue('package');
  });

  it('saves a new layout while nothing uses the target', async () => {
    const api = page([external()]);
    const r = await open('Finance lake');
    await userEvent.selectOptions(within(r).getByLabelText('Layout'), 'package');
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updatePublishTarget).toHaveBeenCalledWith('finance-lake', { layout: 'package' }),
    );
  });

  it('the external form shows a connection picker and no secret field', async () => {
    const api = page([target()], {
      createPublishTarget: vi.fn(async () => external()),
      testPublishTarget: vi.fn(async () => ({ ok: true, step: null, message: 'fine' })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add publishing target' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'External' }));
    for (const field of ['Region', 'Endpoint', 'Access key id', 'Secret access key']) {
      expect(within(dialog).queryByLabelText(field)).toBeNull();
    }
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Finance lake');
    await userEvent.type(within(dialog).getByLabelText('Bucket'), 'finance-bucket');
    const picker = await within(dialog).findByRole('combobox', { name: 'Connection' });
    expect(
      within(picker).getByRole('option', { name: 'Finance account (OK)' }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(picker, 'Finance account (OK)');
    const body = {
      id: 'finance-lake',
      label: 'Finance lake',
      layout: 'files',
      kind: 'external',
      bucket: 'finance-bucket',
      prefix: '',
      connectionId: 'finance-account',
      sse: 'none',
    };
    await userEvent.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('fine');
    expect(api.testPublishTarget).toHaveBeenCalledWith(body);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.createPublishTarget).toHaveBeenCalledWith(body));
  });

  it('points to the connections page when there is no connection yet', async () => {
    page([target()], { listSharedConnections: vi.fn(async () => []) });
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add publishing target' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'External' }));
    expect(
      await within(dialog).findByText(
        'No connections yet: add one under Manage connections, then come back.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('lays the add dialog out in labelled groups, encryption folded away', async () => {
    page([target()]);
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add publishing target' });
    expect(dialog).toHaveAccessibleDescription(/where a recipe delivers its published outputs/i);
    const where = within(dialog).getByRole('group', { name: 'Where' });
    expect(within(where).getByLabelText('Label')).toBeInTheDocument();
    expect(within(where).getByLabelText('Bucket')).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Connection' })).toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: 'External' }));
    const connection = within(dialog).getByRole('group', { name: 'Connection' });
    expect(await within(connection).findByLabelText('Connection')).toBeInTheDocument();
    expect(within(connection).queryByLabelText('Secret access key')).toBeNull();
    const more = within(dialog).getByText('Encryption and storage class').closest('details')!;
    expect(more).not.toHaveAttribute('open');
    expect(more).toHaveTextContent('None · bucket default');
    expect(within(more).getByLabelText('Server-side encryption')).toHaveValue('none');
  });

  it('shows the chosen encryption and storage class on the folded section', async () => {
    const api = page([target()], { createPublishTarget: vi.fn(async () => external()) });
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add publishing target' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'External' }));
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Archive');
    await userEvent.type(within(dialog).getByLabelText('Bucket'), 'archive');
    await userEvent.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Connection' }),
      'Finance account (OK)',
    );
    const more = within(dialog).getByText('Encryption and storage class').closest('details')!;
    await userEvent.click(within(more).getByText('Encryption and storage class'));
    expect(more).toHaveAttribute('open');
    await userEvent.selectOptions(within(more).getByLabelText('Server-side encryption'), 'aws:kms');
    await userEvent.selectOptions(within(more).getByLabelText('Storage class'), 'GLACIER_IR');
    await userEvent.type(within(more).getByLabelText('KMS key id'), 'key-1');
    expect(more).toHaveTextContent('aws:kms · GLACIER_IR');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(api.createPublishTarget).toHaveBeenCalledWith(
        expect.objectContaining({ sse: 'aws:kms', kmsKeyId: 'key-1', storageClass: 'GLACIER_IR' }),
      ),
    );
  });

  it('keeps the browser from filling the id with a saved email', async () => {
    page([target()]);
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add publishing target' });
    const id = within(dialog).getByLabelText('Id');
    expect(id).toHaveAttribute('autocomplete', 'off');
    expect(id).toHaveAttribute('name', 'publish-target-id');
    expect(id).toHaveAccessibleDescription(
      'Use the same id on every deployment for the same recipient.',
    );
    expect(within(dialog).getByLabelText('Label')).toHaveAttribute('autocomplete', 'off');
  });

  it('keeps a refusal in the dialog', async () => {
    page([target()], {
      createPublishTarget: vi.fn(async () => {
        throw new Error('the delivery bridge could not be reached');
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add publishing target' });
    await userEvent.type(within(dialog).getByLabelText('Label'), 'X');
    await userEvent.type(within(dialog).getByLabelText('Bucket'), 'xbucket');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'the delivery bridge could not be reached',
    );
  });
});

describe('Manage connections', () => {
  it('opens the link in a new tab', async () => {
    const api = page([target()], { openConnections: vi.fn(async () => undefined) });
    await userEvent.click(await screen.findByRole('button', { name: 'Manage connections' }));
    expect(api.openConnections).toHaveBeenCalledTimes(1);
  });

  it('keeps a refusal on the page', async () => {
    page([target()], {
      openConnections: vi.fn(async () => {
        throw new Error('admins only');
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Manage connections' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('admins only');
  });
});

describe('AdminDialog Published outputs tab', () => {
  it('opens with Add target in the header', async () => {
    localStorage.removeItem('ih.adminTab');
    render(<AdminDialog api={fakeApi()} me={admin} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Administration' });
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Published outputs' }));
    expect(within(dialog).getByRole('tabpanel')).toHaveAccessibleName('Published outputs');
    expect(
      await within(dialog.querySelector('header')!).findByRole('button', { name: 'Add target' }),
    ).toBeInTheDocument();
    localStorage.removeItem('ih.adminTab');
  });

  it('shows the triple store with its endpoint and dataset, offering Rename and Test only', async () => {
    const api = page([target(), tripleStore()]);
    const store = await row('Triple store');
    expect(store).toHaveTextContent('Triple store');
    expect(store).toHaveTextContent('http://fuseki:3030');
    expect(store).toHaveTextContent('dataset ct');
    const opened = await open('Triple store');
    expect(within(opened).getByLabelText('Label')).toHaveValue('Triple store');
    for (const field of ['Bucket', 'Prefix', 'Connection', 'Server-side encryption']) {
      expect(within(opened).queryByLabelText(field)).toBeNull();
    }
    expect(within(opened).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(opened).toHaveTextContent('From RDF_ENDPOINT');
    expect(within(opened).getByRole('button', { name: 'Test connection' })).toBeEnabled();
    const label = within(opened).getByLabelText('Label');
    await userEvent.clear(label);
    await userEvent.type(label, 'Knowledge graph');
    await userEvent.click(within(opened).getByRole('button', { name: 'Save' }));
    expect(api.updatePublishTarget).toHaveBeenCalledWith('rdf-default', {
      label: 'Knowledge graph',
    });
  });
  it('a target not on the bridge is tagged and its fields are read-only', async () => {
    page([external({ onBridge: false })]);
    const r = await open('Finance lake');
    expect(r).toHaveTextContent('Not on the bridge');
    expect(r).toHaveTextContent(
      'The delivery bridge no longer has this target; deliveries to it fail until it is added back.',
    );
    expect(within(r).getByLabelText('Label')).toHaveAttribute('readonly');
    expect(within(r).getByLabelText('Bucket')).toHaveAttribute('readonly');
    expect(within(r).getByLabelText('Prefix')).toHaveAttribute('readonly');
    expect(within(r).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(within(r).getByRole('button', { name: 'Test connection' })).toBeDisabled();
  });

  it("a sink target opens on its sink's fields; fixed ones lock while it is in use", async () => {
    const api = page(
      [sinkTarget({ usage: { ...NO_USE, publishedVersions: 1, documentTypes: ['letter'] } })],
      {
        listSinks: vi.fn(async () => [FAKE_SINK]),
      },
    );
    const row0 = await row('Fake target');
    expect(row0).toHaveTextContent('Fake sink');
    expect(row0).toHaveTextContent('Deliver-only');
    const r = await open('Fake target');
    expect(within(r).getByLabelText('Space')).toBeDisabled();
    const name = within(r).getByLabelText('Name');
    expect(name).toBeEnabled();
    await userEvent.clear(name);
    await userEvent.type(name, '{{field:sender}');
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }));
    expect(api.updatePublishTarget).toHaveBeenCalledWith('fake-target', {
      destination: { space: 'reports', name: '{field:sender}' },
    });
    expect(within(r).getByRole('button', { name: /Remove/ })).toBeDisabled();
  });

  it('a sink target whose sink is not available now shows that, and only its label saves', async () => {
    const api = page([sinkTarget()], { listSinks: vi.fn(async () => []) });
    const r = await open('Fake target');
    expect(r).toHaveTextContent('fake is not available on the delivery bridge now');
    expect(within(r).getByRole('button', { name: 'Save' })).toBeDisabled();
    const label = within(r).getByLabelText('Label');
    await userEvent.clear(label);
    await userEvent.type(label, 'Renamed');
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }));
    expect(api.updatePublishTarget).toHaveBeenCalledWith('fake-target', { label: 'Renamed' });
  });

  it("a personal sink target's instance can't change once saved", async () => {
    const personal = {
      ...FAKE_SINK,
      connectionKind: 'personal' as const,
      instances: [
        { id: 'sandbox', label: 'Sandbox' },
        { id: 'prod', label: 'Production' },
      ],
    };
    page([sinkTarget({ instanceId: 'sandbox', connectionId: null })], {
      listSinks: vi.fn(async () => [personal]),
    });
    const r = await open('Fake target');
    expect(within(r).getByLabelText('Instance')).toBeDisabled();
  });

  it('adds a target of another system from its declared fields', async () => {
    const api = page([target()], {
      listSinks: vi.fn(async () => [S3_SINK, FAKE_SINK]),
      listSharedConnections: vi.fn(async (sinkId?: string) =>
        sinkId === 'fake'
          ? [
              {
                id: 'fake-account',
                name: 'Fake account',
                status: 'ok' as const,
                statusReason: null,
              },
            ]
          : [],
      ),
      browseSink: vi.fn(async () => ({
        nodes: [
          { id: 'reports', label: 'Reports', kind: 'space', hasChildren: false, selectable: true },
        ],
        nextCursor: null,
      })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add publishing target' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Other system' }));
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Fake target');
    await userEvent.type(within(dialog).getByLabelText('Name'), '{{source.stem}');
    // A browsable field is chosen, not typed: Browse waits for a connection to read with.
    expect(within(dialog).getByRole('button', { name: 'Browse Space' })).toBeDisabled();
    await within(dialog).findByRole('option', { name: 'Fake account (OK)' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Connection'), 'fake-account');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Browse Space' }));
    const browse = await screen.findByRole('dialog', { name: 'Choose space' });
    await userEvent.click(await within(browse).findByRole('button', { name: 'Reports' }));
    expect(within(dialog).getByLabelText('Space')).toHaveValue('Reports [reports]');
    expect(within(dialog).queryByRole('button', { name: 'Test connection' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(api.createPublishTarget).toHaveBeenCalledWith({
      kind: 'sink',
      id: 'fake-target',
      label: 'Fake target',
      sinkId: 'fake',
      instanceId: null,
      connectionId: 'fake-account',
      destination: { space: 'reports', name: '{source.stem}' },
    });
  });

  it('lists the systems read-only', async () => {
    page([target()], { listSinks: vi.fn(async () => [S3_SINK, FAKE_SINK]) });
    const systems = await screen.findByRole('table', { name: 'Systems' });
    const rows = within(systems).getAllByRole('row');
    expect(rows[2]).toHaveTextContent('Fake sink');
    expect(rows[2]).toHaveTextContent('Available');
    expect(rows[2]).toHaveTextContent('Deliver-only');
    expect(rows[1]).toHaveTextContent('Can withdraw, read back, replace');
  });

  it("the triple store's endpoint comes from its connection", async () => {
    page([tripleStore({ endpoint: null })]);
    const store = await row('Triple store');
    expect(store).toHaveTextContent('endpoint not known');
    expect(store).toHaveTextContent('dataset ct');
  });
});
