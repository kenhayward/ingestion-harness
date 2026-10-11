import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JobCleanup } from '../src/components/JobCleanup.js';
import { fakeApi } from './fake-api.js';

describe('JobCleanup', () => {
  it('previews, then deletes finished jobs older than N days', async () => {
    const cleanupJobs = vi.fn(async (_d: number, dryRun: boolean) =>
      dryRun ? { count: 37 } : { deleted: 37 },
    );
    const onChanged = vi.fn();
    render(<JobCleanup api={fakeApi({ cleanupJobs })} onChanged={onChanged} />);
    const days = screen.getByLabelText('Delete finished jobs older than (days)');
    expect(days).toHaveValue(30);
    await userEvent.clear(days);
    await userEvent.type(days, '60');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(cleanupJobs).toHaveBeenLastCalledWith(60, true);
    expect(
      await screen.findByText('37 jobs will be deleted (published copies are kept).', {
        exact: false,
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete 37 jobs' }));
    expect(cleanupJobs).toHaveBeenLastCalledWith(60, false);
    expect(await screen.findByRole('status')).toHaveTextContent('Deleted 37 jobs.');
    expect(onChanged).toHaveBeenCalled();
  });

  it('says when nothing matches', async () => {
    render(<JobCleanup api={fakeApi()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('No finished jobs older than 30 days.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete \d+ jobs/ })).not.toBeInTheDocument();
  });

  it('keeps without deleting, and shows errors', async () => {
    const cleanupJobs = vi
      .fn()
      .mockResolvedValueOnce({ count: 3 })
      .mockRejectedValueOnce(new Error('olderThanDays: too small'));
    render(<JobCleanup api={fakeApi({ cleanupJobs })} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep' }));
    expect(screen.queryByText(/jobs will be deleted/)).not.toBeInTheDocument();
    expect(cleanupJobs).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('olderThanDays: too small');
  });
});
