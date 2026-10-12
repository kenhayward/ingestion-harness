import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { RunsTab } from '../src/workbench/RunsTab.js';
import { fakeApi, job } from './fake-api.js';

describe('RunsTab', () => {
  it('runs the draft on the dev samples and lists the runs with review links', async () => {
    const done = job({ filename: 's1.pdf', status: 'awaiting_review', test: true, specVersion: 2 });
    const queued = job({ filename: 's2.pdf', status: 'queued', test: true, specVersion: 2 });
    const listTestRuns = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([done, queued]);
    const api = fakeApi({
      listTestRuns,
      runDevTests: vi.fn(async () => ({ jobs: [done, queued] })),
    });
    render(<RunsTab api={api} projectId="letter" draft={2} pollMs={60_000} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run on dev samples' }));
    expect(api.runDevTests).toHaveBeenCalledWith('letter');
    const table = await screen.findByRole('table', { name: 'Test runs' });
    const row = within(table).getByRole('cell', { name: 's1.pdf' }).closest('tr')!;
    expect(within(row).getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      `#/review/${done.id}`,
    );
    const pending = within(table).getByRole('cell', { name: 's2.pdf' }).closest('tr')!;
    expect(within(pending).queryByRole('link')).toBeNull();
  });

  it('shows why a run was refused', async () => {
    const api = fakeApi({
      runDevTests: vi.fn(async () => {
        throw new ApiError('no prepared dev samples to run', 409);
      }),
    });
    render(<RunsTab api={api} projectId="letter" draft={1} pollMs={60_000} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run on dev samples' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no prepared dev samples to run');
  });

  it('disables the run button while the request is in flight', async () => {
    let finish!: () => void;
    const api = fakeApi({
      runDevTests: vi.fn(
        () =>
          new Promise<{ jobs: never[] }>((resolve) => {
            finish = () => resolve({ jobs: [] });
          }),
      ),
    });
    render(<RunsTab api={api} projectId="letter" draft={1} pollMs={60_000} />);
    const button = await screen.findByRole('button', { name: 'Run on dev samples' });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    finish();
    await waitFor(() => expect(button).toBeEnabled());
    expect(api.runDevTests).toHaveBeenCalledTimes(1);
  });

  it('cannot run without an open draft', async () => {
    render(<RunsTab api={fakeApi()} projectId="letter" draft={null} pollMs={60_000} />);
    expect(await screen.findByRole('button', { name: 'Run on dev samples' })).toBeDisabled();
  });
});
