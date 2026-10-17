import type { PublishTargetView } from '@ih/shared';
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
    bucket: 'ingest-published',
    prefix: '',
    endpoint: null,
    region: null,
    accessKeyId: null,
    secretSet: false,
    keysFromEnv: null,
    forcePathStyle: false,
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
    endpoint: 'https://s3.example.com',
    region: 'eu-west-1',
    accessKeyId: 'AKIA1',
    secretSet: true,
    source: 'ui',
    updatedBy: 'Sam',
    usage: NO_USE,
    ...over,
  });

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
    expect(within(r).getByLabelText('Region')).toHaveAttribute('readonly');
    expect(within(r).getByLabelText('Label')).not.toHaveAttribute('readonly');
    expect(r).toHaveTextContent('In use: add a new target to move');
  });

  it('leaves the fields editable when nothing uses the target', async () => {
    page([external()]);
    const r = await open('Finance lake');
    expect(within(r).getByLabelText('Bucket')).not.toHaveAttribute('readonly');
    expect(r).not.toHaveTextContent('In use: add a new target to move');
  });

  it('shows no credential fields for an internal target, and says where keys come from', async () => {
    page([
      target(),
      external({
        secretSet: false,
        accessKeyId: null,
        keysFromEnv: { accessKey: 'TARGET_S3_ACCESS_KEY', secretKey: 'TARGET_S3_SECRET_KEY' },
      }),
    ]);
    const def = await open('Default');
    expect(within(def).queryByLabelText('Region')).toBeNull();
    expect(within(def).queryByText(/Secret stored/)).toBeNull();
    const fin = await open('Finance lake');
    expect(fin).toHaveTextContent('Keys from .env (TARGET_S3_ACCESS_KEY, TARGET_S3_SECRET_KEY)');
  });

  it('saves changed fields, and replaces the keys as a pair', async () => {
    const api = page([external()], {
      updatePublishTarget: vi.fn(async () => external({ label: 'Finance' })),
    });
    const r = await open('Finance lake');
    expect(r).toHaveTextContent('Secret stored (encrypted)');
    const label = within(r).getByLabelText('Label');
    await userEvent.clear(label);
    await userEvent.type(label, 'Finance');
    await userEvent.click(within(r).getByRole('button', { name: 'Set secret' }));
    await userEvent.type(within(r).getByLabelText('New access key id'), 'AKIA2');
    await userEvent.type(within(r).getByLabelText('New secret access key'), 'shh');
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updatePublishTarget).toHaveBeenCalledWith('finance-lake', {
        label: 'Finance',
        accessKeyId: 'AKIA2',
        secretAccessKey: 'shh',
      }),
    );
  });

  it('clears the typed keys and the old test result after saving', async () => {
    page([external()], {
      updatePublishTarget: vi.fn(async () => external()),
      testPublishTarget: vi.fn(async () => ({ ok: true, step: null, message: 'fine' })),
    });
    const r = await open('Finance lake');
    await userEvent.click(within(r).getByRole('button', { name: 'Test connection' }));
    expect(await within(r).findByRole('status')).toBeInTheDocument();
    await userEvent.click(within(r).getByRole('button', { name: 'Set secret' }));
    await userEvent.type(within(r).getByLabelText('New access key id'), 'AKIA2');
    await userEvent.type(within(r).getByLabelText('New secret access key'), 'shh');
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(r).queryByLabelText('New secret access key')).toBeNull());
    expect(within(r).queryByRole('status')).toBeNull();
    expect(within(r).getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(within(r).getByRole('button', { name: 'Set secret' }));
    expect(within(r).getByLabelText('New secret access key')).toHaveValue('');
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

  it('clears the storage class, the KMS key and the endpoint with null', async () => {
    const stored = external({ sse: 'aws:kms', kmsKeyId: 'key-1', storageClass: 'STANDARD_IA' });
    const api = page([stored], { updatePublishTarget: vi.fn(async () => stored) });
    const r = await open('Finance lake');
    await userEvent.selectOptions(within(r).getByLabelText('Storage class'), 'Bucket default');
    await userEvent.clear(within(r).getByLabelText('KMS key id'));
    await userEvent.clear(within(r).getByLabelText('Endpoint'));
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updatePublishTarget).toHaveBeenCalledWith('finance-lake', {
        endpoint: null,
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
        kind: 'internal',
        bucket: 'archive-bucket',
        prefix: 'out',
      }),
    );
  });

  it('adds an external target with its secret, after a test connection', async () => {
    const api = page([target()], {
      createPublishTarget: vi.fn(async () => external()),
      testPublishTarget: vi.fn(async () => ({ ok: true, step: null, message: 'fine' })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add publishing target' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'External' }));
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Finance lake');
    await userEvent.type(within(dialog).getByLabelText('Bucket'), 'finance-bucket');
    await userEvent.type(within(dialog).getByLabelText('Endpoint'), 'https://s3.example.com');
    await userEvent.type(within(dialog).getByLabelText('Region'), 'eu-west-1');
    await userEvent.type(within(dialog).getByLabelText('Access key id'), 'AKIA1');
    await userEvent.type(within(dialog).getByLabelText('Secret access key'), 'shh');
    const body = {
      id: 'finance-lake',
      label: 'Finance lake',
      kind: 'external',
      bucket: 'finance-bucket',
      prefix: '',
      endpoint: 'https://s3.example.com',
      region: 'eu-west-1',
      accessKeyId: 'AKIA1',
      secretAccessKey: 'shh',
      forcePathStyle: false,
      sse: 'none',
    };
    await userEvent.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('fine');
    expect(api.testPublishTarget).toHaveBeenCalledWith(body);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.createPublishTarget).toHaveBeenCalledWith(body));
  });

  it('keeps a refusal in the dialog', async () => {
    page([target()], {
      createPublishTarget: vi.fn(async () => {
        throw new Error('LLM_SECRETS_KEY is not set: the API cannot store keys');
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add publishing target' });
    await userEvent.type(within(dialog).getByLabelText('Label'), 'X');
    await userEvent.type(within(dialog).getByLabelText('Bucket'), 'xbucket');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('LLM_SECRETS_KEY');
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
});
