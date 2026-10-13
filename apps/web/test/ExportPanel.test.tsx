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
    render(<ExportPanel api={api} projectId="letter" dataPolicy="external" pollMs={10} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Export bundle' }));
    expect(api.startExport).toHaveBeenCalledWith('letter');
    const link = await screen.findByRole('link', { name: 'Download bundle' });
    expect(link).toHaveAttribute('href', api.exportBundleUrl('letter', 'j1'));
  });

  it('says local-only exports need the admin token', async () => {
    render(<ExportPanel api={fakeApi()} projectId="letter" dataPolicy="local" pollMs={10} />);
    expect(await screen.findByText(/admin token/)).toBeInTheDocument();
  });

  it('shows a failed export', async () => {
    const api = fakeApi({
      listExports: vi.fn(async () => [exp({ status: 'needs_review', error: 'boom' })]),
    });
    render(<ExportPanel api={api} projectId="letter" dataPolicy="external" pollMs={10} />);
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download bundle' })).not.toBeInTheDocument();
  });

  it('shows the server error when the export is refused', async () => {
    const api = fakeApi({
      startExport: vi.fn(async () => {
        throw new Error('exporting a local-only project needs the admin token');
      }),
    });
    render(<ExportPanel api={api} projectId="letter" dataPolicy="external" pollMs={10} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Export bundle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needs the admin token');
  });
});
