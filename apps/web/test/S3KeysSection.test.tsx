import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type IssuedS3Key, type S3Consumer, type S3Key } from '../src/api/client.js';
import { S3KeysSection } from '../src/access/S3KeysSection.js';
import { fakeApi } from './fake-api.js';

const DAY = 86_400_000;
const key = (o: Partial<S3Key> = {}): S3Key => ({
  id: crypto.randomUUID(),
  accessKeyId: 'AKLAKE0001',
  createdAt: new Date(Date.now() - 10 * DAY).toISOString(),
  expiresAt: new Date(Date.now() + 80 * DAY).toISOString(),
  revokedAt: null,
  status: 'active',
  ...o,
});
const consumer = (o: Partial<S3Consumer> = {}): S3Consumer => ({
  id: crypto.randomUUID(),
  label: 'Semantic index',
  userName: 'lake-1',
  createdAt: new Date(Date.now() - 10 * DAY).toISOString(),
  keys: [key()],
  ...o,
});
const overview = (consumers: S3Consumer[], endpoint: string | null = 'https://lake.example.com') =>
  vi.fn(async () => ({ bucket: 'ingest-published', endpoint, consumers }));
const issued = (c: S3Consumer, accessKeyId = 'AKNEW0002'): IssuedS3Key => ({
  consumer: c,
  key: key({ accessKeyId }),
  secretAccessKey: 'SECRET/abc+123',
  bucket: 'ingest-published',
  endpoint: 'https://lake.example.com',
});
const card = (label: string) => screen.getByRole('region', { name: label });

afterEach(() => vi.unstubAllGlobals());

describe('S3KeysSection', () => {
  it('lists consumers with their keys, expiry and status', async () => {
    const lake = consumer({
      keys: [
        key(),
        key({ accessKeyId: 'AKOLD', status: 'revoked', revokedAt: new Date().toISOString() }),
      ],
    });
    render(<S3KeysSection api={fakeApi({ listS3Keys: overview([lake]) })} />);
    const section = await screen.findByRole('region', { name: 'Semantic index' });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Data lake S3 keys' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/ingest-published/)).toBeInTheDocument();
    const active = within(section).getByRole('row', { name: /AKLAKE0001/ });
    expect(within(active).getByText('Active')).toBeInTheDocument();
    expect(within(active).getByText('in 11 weeks')).toBeInTheDocument();
    expect(within(active).getByRole('button', { name: 'Revoke AKLAKE0001' })).toBeInTheDocument();
    const revoked = within(section).getByRole('row', { name: /AKOLD/ });
    expect(within(revoked).getByText('Revoked')).toBeInTheDocument();
    expect(within(revoked).queryByRole('button')).toBeNull();
  });

  it('issues a key and shows everything the lake needs, once', async () => {
    const lake = consumer();
    const createS3Key = vi.fn(async () => issued(lake, 'AKLAKE0001'));
    const api = fakeApi({ listS3Keys: overview([]), createS3Key });
    render(<S3KeysSection api={api} />);
    const form = await screen.findByRole('form', { name: 'Issue an S3 key' });
    await userEvent.type(within(form).getByLabelText('Consumer'), 'Semantic index');
    await userEvent.click(within(form).getByRole('button', { name: '1 year' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Create key' }));
    expect(createS3Key).toHaveBeenCalledWith('Semantic index', 365);

    const panel = screen.getByRole('region', { name: 'New S3 key' });
    expect(within(panel).getByLabelText('Endpoint URL')).toHaveValue('https://lake.example.com');
    expect(within(panel).getByLabelText('Bucket')).toHaveValue('ingest-published');
    expect(within(panel).getByLabelText('Access key ID')).toHaveValue('AKLAKE0001');
    expect(within(panel).getByLabelText('Secret access key')).toHaveValue('SECRET/abc+123');
    expect(api.listS3Keys).toHaveBeenCalledTimes(2);

    await userEvent.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region', { name: 'New S3 key' })).toBeNull();
    expect(screen.queryByDisplayValue('SECRET/abc+123')).toBeNull();
  });

  it('says where to set the endpoint when the public URL is not configured', async () => {
    const lake = consumer();
    const createS3Key = vi.fn(async () => ({ ...issued(lake), endpoint: null }));
    render(<S3KeysSection api={fakeApi({ listS3Keys: overview([], null), createS3Key })} />);
    const form = await screen.findByRole('form', { name: 'Issue an S3 key' });
    await userEvent.type(within(form).getByLabelText('Consumer'), 'x');
    await userEvent.click(within(form).getByRole('button', { name: 'Create key' }));
    const panel = screen.getByRole('region', { name: 'New S3 key' });
    expect(within(panel).getByLabelText('Endpoint URL')).toHaveValue('');
    expect(within(panel).getByText(/S3_PUBLIC_URL/)).toBeInTheDocument();
  });

  it('copies the secret, saying so', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const lake = consumer();
    render(
      <S3KeysSection
        api={fakeApi({ listS3Keys: overview([]), createS3Key: vi.fn(async () => issued(lake)) })}
      />,
    );
    const form = await screen.findByRole('form', { name: 'Issue an S3 key' });
    await userEvent.type(within(form).getByLabelText('Consumer'), 'x');
    await userEvent.click(within(form).getByRole('button', { name: 'Create key' }));
    await userEvent.click(screen.getByRole('button', { name: 'Copy secret access key' }));
    expect(writeText).toHaveBeenCalledWith('SECRET/abc+123');
    expect(screen.getByRole('status')).toHaveTextContent('Copied.');
  });

  it('rotates with a grace period and shows the new key', async () => {
    const lake = consumer();
    const rotateS3Key = vi.fn(async () => issued(lake));
    render(<S3KeysSection api={fakeApi({ listS3Keys: overview([lake]), rotateS3Key })} />);
    await screen.findByRole('region', { name: 'Semantic index' });
    await userEvent.click(within(card('Semantic index')).getByRole('button', { name: 'Rotate' }));
    const rotate = within(card('Semantic index')).getByRole('form', {
      name: 'Rotate Semantic index',
    });
    expect(
      within(within(rotate).getByRole('group', { name: 'Old key stops after' })).getByRole(
        'button',
        { name: '7 days' },
      ),
    ).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(
      within(within(rotate).getByRole('group', { name: 'Old key stops after' })).getByRole(
        'button',
        { name: '1 day' },
      ),
    );
    await userEvent.click(within(rotate).getByRole('button', { name: 'Rotate now' }));
    expect(rotateS3Key).toHaveBeenCalledWith(lake.id, 90, 1);
    expect(
      within(screen.getByRole('region', { name: 'New S3 key' })).getByLabelText('Access key ID'),
    ).toHaveValue('AKNEW0002');
  });

  it('offers no rotation while a consumer has two active keys', async () => {
    const lake = consumer({ keys: [key(), key({ accessKeyId: 'AKOTHER' })] });
    render(<S3KeysSection api={fakeApi({ listS3Keys: overview([lake]) })} />);
    const section = await screen.findByRole('region', { name: 'Semantic index' });
    expect(within(section).queryByRole('button', { name: 'Rotate' })).toBeNull();
    expect(within(section).getByText(/revoke one to rotate/i)).toBeInTheDocument();
  });

  it('revokes a key only after confirming', async () => {
    const lake = consumer();
    const api = fakeApi({ listS3Keys: overview([lake]) });
    render(<S3KeysSection api={api} />);
    const section = await screen.findByRole('region', { name: 'Semantic index' });
    await userEvent.click(within(section).getByRole('button', { name: 'Revoke AKLAKE0001' }));
    expect(api.revokeS3Key).not.toHaveBeenCalled();
    await userEvent.click(within(section).getByRole('button', { name: 'Keep' }));
    expect(api.revokeS3Key).not.toHaveBeenCalled();
    await userEvent.click(within(section).getByRole('button', { name: 'Revoke AKLAKE0001' }));
    await userEvent.click(within(section).getByRole('button', { name: 'Revoke now' }));
    expect(api.revokeS3Key).toHaveBeenCalledWith(lake.keys[0]!.id);
  });

  it('deletes a consumer only after confirming', async () => {
    const lake = consumer();
    const api = fakeApi({ listS3Keys: overview([lake]) });
    render(<S3KeysSection api={api} />);
    const section = await screen.findByRole('region', { name: 'Semantic index' });
    await userEvent.click(within(section).getByRole('button', { name: 'Delete Semantic index' }));
    expect(within(section).getByText(/its keys stop working now/i)).toBeInTheDocument();
    await userEvent.click(within(section).getByRole('button', { name: 'Delete' }));
    expect(api.deleteS3Consumer).toHaveBeenCalledWith(lake.id);
  });

  it('explains when keys are not available, without a form', async () => {
    const listS3Keys = vi.fn(async () => {
      throw new ApiError(
        'S3 keys are not available: the publish target is not the local SeaweedFS',
        404,
      );
    });
    render(<S3KeysSection api={fakeApi({ listS3Keys })} />);
    expect(
      await screen.findByText(/publish target is not the local SeaweedFS/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Issue an S3 key' })).toBeNull();
  });

  it('shows other errors and keeps the list', async () => {
    const lake = consumer();
    const revokeS3Key = vi.fn(async () => {
      throw new ApiError('Revoked, but SeaweedFS could not be reached', 502);
    });
    render(<S3KeysSection api={fakeApi({ listS3Keys: overview([lake]), revokeS3Key })} />);
    const section = await screen.findByRole('region', { name: 'Semantic index' });
    await userEvent.click(within(section).getByRole('button', { name: 'Revoke AKLAKE0001' }));
    await userEvent.click(within(section).getByRole('button', { name: 'Revoke now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('SeaweedFS could not be reached');
    expect(screen.getByRole('region', { name: 'Semantic index' })).toBeInTheDocument();
  });
});
