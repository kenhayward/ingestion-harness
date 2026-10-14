import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CleanupRequest } from '../src/api/client.js';
import { JobCleanup } from '../src/jobs/JobCleanup.js';
import { fakeApi } from './fake-api.js';

const CUTOFF = '2026-09-11T00:00:00.000Z';

describe('JobCleanup', () => {
  it('previews, then deletes exactly what was previewed, in batches', async () => {
    let left = 150;
    const cleanupJobs = vi.fn(async (req: CleanupRequest) => {
      if (req.dryRun) return { count: 150, cutoff: CUTOFF };
      const deleted = Math.min(100, left);
      left -= deleted;
      return { deleted, remaining: left, cutoff: CUTOFF };
    });
    const onChanged = vi.fn();
    render(<JobCleanup api={fakeApi({ cleanupJobs })} onChanged={onChanged} />);
    const days = screen.getByLabelText('Delete finished jobs older than (days)');
    expect(days).toHaveValue(30);
    await userEvent.clear(days);
    await userEvent.type(days, '60');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(cleanupJobs).toHaveBeenLastCalledWith({
      olderThanDays: 60,
      dryRun: true,
      includeRegression: false,
    });
    expect(
      await screen.findByText('150 jobs will be deleted (what they published is withdrawn).', {
        exact: false,
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete 150 jobs' }));
    expect(await screen.findByText('Deleted 150 jobs.')).toBeInTheDocument();
    const deletes = cleanupJobs.mock.calls.map((c) => c[0]).filter((r) => !r.dryRun);
    expect(deletes).toHaveLength(2);
    expect(deletes.every((r) => r.cutoff === CUTOFF)).toBe(true);
    expect(onChanged).toHaveBeenCalled();
  });

  it('can include regression runs', async () => {
    const cleanupJobs = vi.fn(async () => ({ count: 0, cutoff: CUTOFF }));
    render(<JobCleanup api={fakeApi({ cleanupJobs })} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include regression runs' }));
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(cleanupJobs).toHaveBeenLastCalledWith({
      olderThanDays: 30,
      dryRun: true,
      includeRegression: true,
    });
  });

  it('uses the singular for one job', async () => {
    const cleanupJobs = vi.fn(async (req: CleanupRequest) =>
      req.dryRun ? { count: 1, cutoff: CUTOFF } : { deleted: 1, remaining: 0, cutoff: CUTOFF },
    );
    render(<JobCleanup api={fakeApi({ cleanupJobs })} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(
      await screen.findByText('1 job will be deleted (what they published is withdrawn).', {
        exact: false,
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete 1 job' }));
    expect(await screen.findByText('Deleted 1 job.')).toBeInTheDocument();
  });

  it('says when nothing matches', async () => {
    render(<JobCleanup api={fakeApi()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('No finished jobs older than 30 days.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete \d+ jobs?$/ })).not.toBeInTheDocument();
  });

  it.each(['', '0', '2.5', '4000'])('refuses to preview with %j days', async (value) => {
    const cleanupJobs = vi.fn();
    render(<JobCleanup api={fakeApi({ cleanupJobs })} onChanged={vi.fn()} />);
    const days = screen.getByLabelText('Delete finished jobs older than (days)');
    await userEvent.clear(days);
    if (value) await userEvent.type(days, value);
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(screen.getByText('Enter whole days from 1 to 3650.')).toBeInTheDocument();
    expect(cleanupJobs).not.toHaveBeenCalled();
  });

  it('keeps without deleting, and shows errors from preview and delete', async () => {
    const cleanupJobs = vi
      .fn()
      .mockResolvedValueOnce({ count: 3, cutoff: CUTOFF })
      .mockResolvedValueOnce({ count: 3, cutoff: CUTOFF })
      .mockRejectedValueOnce(new Error('storage down'));
    render(<JobCleanup api={fakeApi({ cleanupJobs })} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep' }));
    expect(screen.queryByText(/will be deleted/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete 3 jobs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('storage down');
  });
});
