import type { JobStatus } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JobsTable } from '../src/components/JobsTable.js';
import { fakeApi, job } from './fake-api.js';

const row = (name: string) => screen.getByText(name).closest('tr')!;
const buttons = (name: string) =>
  within(row(name))
    .queryAllByRole('button')
    .map((b) => b.textContent);

describe('JobsTable actions', () => {
  it.each<[JobStatus, string[]]>([
    ['queued', ['Cancel']],
    ['running', ['Cancel']],
    ['succeeded', ['Delete']],
    ['failed', ['Retry', 'Delete']],
    ['needs_review', ['Retry', 'Delete']],
    ['cancelled', ['Retry', 'Delete']],
    ['rejected', ['Delete']],
    ['awaiting_review', []],
  ])('%s jobs offer %j', (status, expected) => {
    render(
      <JobsTable api={fakeApi()} jobs={[job({ filename: 'a.pdf', status })]} onChanged={vi.fn()} />,
    );
    expect(buttons('a.pdf')).toEqual(expected);
  });

  it('confirms before deleting, mentions published copies, and refreshes', async () => {
    const api = fakeApi();
    const onChanged = vi.fn();
    const j = job({ filename: 'a.pdf', status: 'succeeded' });
    render(<JobsTable api={api} jobs={[j]} onChanged={onChanged} />);
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    expect(within(row('a.pdf')).getByText(/Delete a\.pdf\?/)).toHaveTextContent(
      'Published copies in the target are kept.',
    );
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Keep' }));
    expect(api.deleteJob).not.toHaveBeenCalled();
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Confirm' }));
    expect(api.deleteJob).toHaveBeenCalledWith(j.id);
    expect(onChanged).toHaveBeenCalled();
  });

  it('confirms before cancelling', async () => {
    const api = fakeApi();
    const j = job({ filename: 'a.pdf', status: 'running' });
    render(<JobsTable api={api} jobs={[j]} onChanged={vi.fn()} />);
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Cancel' }));
    expect(within(row('a.pdf')).getByText('Cancel job?')).toBeInTheDocument();
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Confirm' }));
    expect(api.cancelJob).toHaveBeenCalledWith(j.id);
  });

  it('shows action errors in the row', async () => {
    const api = fakeApi({
      deleteJob: vi.fn(async () => {
        throw new Error('a running job cannot be deleted');
      }),
    });
    render(
      <JobsTable
        api={api}
        jobs={[job({ filename: 'a.pdf', status: 'failed' })]}
        onChanged={vi.fn()}
      />,
    );
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Confirm' }));
    expect(await within(row('a.pdf')).findByRole('alert')).toHaveTextContent(
      'a running job cannot be deleted',
    );
  });
});
