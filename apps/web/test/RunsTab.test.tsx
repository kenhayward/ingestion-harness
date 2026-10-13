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
    render(<RunsTab api={api} projectId="letter" dataPolicy="local" draft={2} pollMs={60_000} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run on dev samples…' }));
    const dialog = screen.getByRole('dialog', { name: 'Run v2 on the dev samples' });
    expect(dialog).toHaveTextContent('every prepared dev sample');
    const model = within(dialog).getByRole('combobox', { name: 'Model' });
    expect(model).toHaveValue('');
    // A local-only project cannot pick an external model choice.
    expect(
      (within(model).getByRole('option', { name: /Cloud model/ }) as HTMLOptionElement).disabled,
    ).toBe(true);
    await userEvent.selectOptions(model, 'New for testing only');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run' }));
    expect(api.runDevTests).toHaveBeenCalledWith('letter', 'test');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
    render(<RunsTab api={api} projectId="letter" dataPolicy="local" draft={1} pollMs={60_000} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run on dev samples…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no prepared dev samples to run');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it("disables the dialog's Run button while the request is in flight", async () => {
    let finish!: () => void;
    const api = fakeApi({
      runDevTests: vi.fn(
        () =>
          new Promise<{ jobs: never[] }>((resolve) => {
            finish = () => resolve({ jobs: [] });
          }),
      ),
    });
    render(<RunsTab api={api} projectId="letter" dataPolicy="local" draft={1} pollMs={60_000} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run on dev samples…' }));
    const button = screen.getByRole('button', { name: 'Run' });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.runDevTests).toHaveBeenCalledTimes(1);
    expect(api.runDevTests).toHaveBeenCalledWith('letter', null);
  });

  it('cannot run without an open draft', async () => {
    render(
      <RunsTab
        api={fakeApi()}
        projectId="letter"
        dataPolicy="local"
        draft={null}
        pollMs={60_000}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Run on dev samples…' })).toBeDisabled();
  });
});
