import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviseTab } from '../src/workbench/ReviseTab.js';
import { fakeApi, feedbackItem } from './fake-api.js';

function tab(overrides = {}) {
  const api = fakeApi(overrides);
  render(
    <ReviseTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      hasDraft
      pollMs={1}
      onApplied={vi.fn()}
    />,
  );
  return api;
}

describe('ReviseTab', () => {
  it('adds feedback', async () => {
    const added = feedbackItem({ targetId: 'sender', body: 'Use the letterhead' });
    const listFeedback = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([added]);
    const api = tab({ listFeedback, addFeedback: vi.fn(async () => added) });
    await userEvent.selectOptions(await screen.findByLabelText('About'), 'field');
    await userEvent.type(screen.getByLabelText('Id'), 'sender');
    await userEvent.type(screen.getByLabelText('Feedback'), 'Use the letterhead');
    await userEvent.click(screen.getByRole('button', { name: 'Add feedback' }));
    expect(api.addFeedback).toHaveBeenCalledWith('letter', {
      target: 'field',
      targetId: 'sender',
      body: 'Use the letterhead',
    });
    const table = await screen.findByRole('table', { name: 'Feedback' });
    expect(within(table).getByText('Use the letterhead')).toBeInTheDocument();
  });

  it('shows resolved feedback without Delete and deletes open feedback', async () => {
    const open = feedbackItem({ body: 'Open one' });
    const done = feedbackItem({ body: 'Done one', resolvedBy: 'p1' });
    const api = tab({
      listFeedback: vi.fn(async () => [open, done]),
      deleteFeedback: vi.fn(async () => undefined),
    });
    const table = await screen.findByRole('table', { name: 'Feedback' });
    const doneRow = within(table).getByText('Done one').closest('tr')!;
    expect(within(doneRow).getByText('resolved')).toBeInTheDocument();
    expect(within(doneRow).queryByRole('button', { name: 'Delete' })).toBeNull();
    await userEvent.click(
      within(within(table).getByText('Open one').closest('tr')!).getByRole('button', {
        name: 'Delete',
      }),
    );
    expect(api.deleteFeedback).toHaveBeenCalledWith('letter', open.id);
  });

  it('offers a revision without a skip button', async () => {
    tab({ listFeedback: vi.fn(async () => [feedbackItem()]) });
    expect(await screen.findByRole('button', { name: 'Propose a revision' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip this stage' })).toBeNull();
  });

  it('shows an error when adding fails', async () => {
    tab({ addFeedback: vi.fn(async () => Promise.reject(new Error('nope'))) });
    await userEvent.type(await screen.findByLabelText('Id'), 'x');
    await userEvent.type(screen.getByLabelText('Feedback'), 'y');
    await userEvent.click(screen.getByRole('button', { name: 'Add feedback' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});
