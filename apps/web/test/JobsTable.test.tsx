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
    ['failed', ['Retry with spec default', 'Delete']],
    ['needs_review', ['Retry with spec default', 'Delete']],
    ['cancelled', ['Retry with spec default', 'Delete']],
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
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Keep a.pdf' }));
    expect(api.deleteJob).not.toHaveBeenCalled();
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(row('a.pdf')).getByRole('button', { name: 'Confirm delete a.pdf' }),
    );
    expect(api.deleteJob).toHaveBeenCalledWith(j.id);
    expect(onChanged).toHaveBeenCalled();
  });

  it('confirms before cancelling', async () => {
    const api = fakeApi();
    const j = job({ filename: 'a.pdf', status: 'running' });
    render(<JobsTable api={api} jobs={[j]} onChanged={vi.fn()} />);
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Cancel' }));
    expect(within(row('a.pdf')).getByText('Cancel job?')).toBeInTheDocument();
    await userEvent.click(
      within(row('a.pdf')).getByRole('button', { name: 'Confirm cancel a.pdf' }),
    );
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
    await userEvent.click(
      within(row('a.pdf')).getByRole('button', { name: 'Confirm delete a.pdf' }),
    );
    expect(await within(row('a.pdf')).findByRole('alert')).toHaveTextContent(
      'a running job cannot be deleted',
    );
  });

  it.each([
    [{ modelsUsed: ['local/qwen', 'anthropic/haiku'] }, 'local/qwen, anthropic/haiku'],
    [{ modelsUsed: [], modelOverride: 'anthropic/opus' }, 'anthropic/opus'],
    [{ modelsUsed: [], modelOverride: null }, 'Spec default'],
  ])('shows the model column: %j', (fields, shown) => {
    render(
      <JobsTable
        api={fakeApi()}
        jobs={[job({ filename: 'a.pdf', ...fields })]}
        onChanged={vi.fn()}
      />,
    );
    const header = screen.getAllByRole('columnheader').map((h) => h.textContent);
    const cells = within(row('a.pdf')).getAllByRole('cell');
    expect(cells[header.indexOf('Model')]).toHaveTextContent(shown);
  });

  it('retries with the currently selected model', async () => {
    const api = fakeApi();
    const j = job({ filename: 'a.pdf', status: 'failed', modelOverride: 'anthropic/old' });
    render(<JobsTable api={api} jobs={[j]} onChanged={vi.fn()} retryModel="anthropic/new" />);
    await userEvent.click(
      within(row('a.pdf')).getByRole('button', { name: 'Retry with anthropic/new' }),
    );
    expect(api.retryJob).toHaveBeenCalledWith(j.id, 'anthropic/new');
  });

  it('retries with the spec default (clearing the override) when no model is selected', async () => {
    const api = fakeApi();
    const j = job({ filename: 'a.pdf', status: 'failed', modelOverride: 'anthropic/old' });
    render(<JobsTable api={api} jobs={[j]} onChanged={vi.fn()} />);
    await userEvent.click(
      within(row('a.pdf')).getByRole('button', { name: 'Retry with spec default' }),
    );
    expect(api.retryJob).toHaveBeenCalledWith(j.id, null);
  });

  it('moves focus into the confirmation and back, and describes it for screen readers', async () => {
    const j = job({ filename: 'a.pdf', status: 'succeeded' });
    render(<JobsTable api={fakeApi()} jobs={[j]} onChanged={vi.fn()} />);
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    const confirm = within(row('a.pdf')).getByRole('button', { name: 'Confirm delete a.pdf' });
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAccessibleDescription(
      'Delete a.pdf? Published copies in the target are kept.',
    );
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Keep a.pdf' }));
    expect(within(row('a.pdf')).getByRole('button', { name: 'Delete' })).toHaveFocus();
  });

  it.each<[JobStatus, boolean]>([
    ['succeeded', true],
    ['awaiting_review', true],
    ['failed', false],
    ['running', false],
  ])('%s jobs link to the review screen: %s', (status, linked) => {
    const j = job({ filename: 'a.pdf', status });
    render(<JobsTable api={fakeApi()} jobs={[j]} onChanged={vi.fn()} />);
    const link = within(row('a.pdf')).queryByRole('link', { name: 'Review' });
    if (linked) expect(link).toHaveAttribute('href', `#/review/${j.id}`);
    else expect(link).not.toBeInTheDocument();
  });
});
