import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ExportView } from '@ih/shared';
import { ExportPanel } from '../src/workbench/ExportPanel.js';
import { fakeApi } from './fake-api.js';

const exp = (overrides: Partial<ExportView> = {}): ExportView => ({
  jobId: 'j1',
  status: 'queued',
  error: null,
  createdAt: 't',
  updatedAt: 't',
  briefVersion: null,
  devSamples: null,
  bytes: null,
  ...overrides,
});

describe('ExportPanel', () => {
  it('starts an export, polls it and offers the download', async () => {
    const listExports = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([exp({ status: 'running' })])
      .mockResolvedValue([exp({ status: 'succeeded' })]);
    const api = fakeApi({ listExports, startExport: vi.fn(async () => exp()) });
    render(
      <ExportPanel api={api} role="admin" projectId="letter" dataPolicy="external" pollMs={10} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Export bundle' }));
    expect(api.startExport).toHaveBeenCalledWith('letter');
    const link = await screen.findByRole('link', { name: 'Download bundle' });
    expect(link).toHaveAttribute('href', api.exportBundleUrl('letter', 'j1'));
  });

  it('says local-only exports need an admin', async () => {
    render(
      <ExportPanel
        api={fakeApi()}
        role="admin"
        projectId="letter"
        dataPolicy="local"
        pollMs={10}
      />,
    );
    expect(await screen.findByText(/needs? an admin/)).toBeInTheDocument();
  });

  it('shows a failed export', async () => {
    const api = fakeApi({
      listExports: vi.fn(async () => [exp({ status: 'needs_review', error: 'boom' })]),
    });
    render(
      <ExportPanel api={api} role="admin" projectId="letter" dataPolicy="external" pollMs={10} />,
    );
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download bundle' })).not.toBeInTheDocument();
  });

  it('shows the server error when the export is refused', async () => {
    const api = fakeApi({
      startExport: vi.fn(async () => {
        throw new Error('exporting a local-only project needs an admin');
      }),
    });
    render(
      <ExportPanel api={api} role="admin" projectId="letter" dataPolicy="external" pollMs={10} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Export bundle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needs an admin');
  });

  it.each<['admin' | 'user', boolean]>([
    ['admin', true],
    ['user', false],
  ])('offers a local-only bundle download to %s: %s', async (role, offered) => {
    const api = fakeApi({ listExports: vi.fn(async () => [exp({ status: 'succeeded' })]) });
    render(<ExportPanel api={api} role={role} projectId="letter" dataPolicy="local" pollMs={10} />);
    expect(await screen.findByText(/Export ready/)).toBeInTheDocument();
    const link = screen.queryByRole('link', { name: 'Download bundle' });
    const note = screen.queryByText("Downloading a local-only project's bundle needs an admin.");
    if (offered) {
      expect(link).toBeInTheDocument();
      expect(note).not.toBeInTheDocument();
    } else {
      expect(link).not.toBeInTheDocument();
      expect(note).toBeInTheDocument();
    }
  });

  it('offers the download to a user on an external project', async () => {
    const api = fakeApi({ listExports: vi.fn(async () => [exp({ status: 'succeeded' })]) });
    render(<ExportPanel api={api} role="user" projectId="letter" dataPolicy="external" />);
    expect(await screen.findByRole('link', { name: 'Download bundle' })).toBeInTheDocument();
  });

  it('clears a polling error once a poll succeeds', async () => {
    const listExports = vi
      .fn()
      .mockResolvedValueOnce([exp({ status: 'running' })])
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue([exp({ status: 'succeeded' })]);
    render(
      <ExportPanel
        api={fakeApi({ listExports })}
        role="admin"
        projectId="letter"
        dataPolicy="external"
        pollMs={10}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    await screen.findByRole('link', { name: 'Download bundle' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('tells what the ready bundle carries and offers it again', async () => {
    const api = fakeApi({
      listExports: vi.fn(async () => [
        exp({ status: 'succeeded', briefVersion: 3, devSamples: 6, bytes: 3_250_000 }),
      ]),
      startExport: vi.fn(async () => exp()),
    });
    render(
      <ExportPanel api={api} role="admin" projectId="letter" dataPolicy="external" pollMs={10} />,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Export ready · brief v3 · 6 dev samples · 3.1 MB',
    );
    expect(screen.getByRole('link', { name: 'Download bundle' })).toHaveTextContent('Download');
    expect(screen.queryByRole('button', { name: 'Export bundle' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Export again' }));
    expect(api.startExport).toHaveBeenCalledWith('letter');
  });

  it('says what the bundle includes, never holdout', async () => {
    render(<ExportPanel api={fakeApi()} role="admin" projectId="letter" dataPolicy="external" />);
    expect(await screen.findByText(/never holdout samples/)).toBeInTheDocument();
  });

  it('notes that a local-only project needs an admin', async () => {
    render(<ExportPanel api={fakeApi()} role="admin" projectId="letter" dataPolicy="local" />);
    expect(
      await screen.findByText('Local-only project: exporting and downloading need an admin.'),
    ).toBeInTheDocument();
  });
});
