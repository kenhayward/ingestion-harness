import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EvaluateTab } from '../src/workbench/EvaluateTab.js';
import { fakeApi, iterationView, projectView } from './fake-api.js';

function tab(overrides = {}, hasDraft = true) {
  const api = fakeApi(overrides);
  const onRestored = vi.fn();
  render(
    <EvaluateTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      hasDraft={hasDraft}
      pollMs={1}
      onRestored={onRestored}
    />,
  );
  return { api, onRestored };
}

describe('EvaluateTab', () => {
  it('evaluates with the chosen model and polls until complete', async () => {
    const running = iterationView({ status: 'running', score: null, completed: 0 });
    const done = iterationView({ id: running.id });
    const { api } = tab({
      listIterations: vi.fn(async () => []),
      startEvaluation: vi.fn(async () => running),
      getIteration: vi.fn().mockResolvedValueOnce(running).mockResolvedValue(done),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Model'), 'fast');
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate the draft' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', 'fast');
    expect(await screen.findByText('Score 75%')).toBeInTheDocument();
  });

  it('reports a failed History refresh once the evaluation completes', async () => {
    const running = iterationView({ status: 'running', score: null, completed: 0 });
    const done = iterationView({ id: running.id });
    tab({
      listIterations: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValue(new Error('history unavailable')),
      startEvaluation: vi.fn(async () => running),
      getIteration: vi.fn().mockResolvedValueOnce(running).mockResolvedValue(done),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Evaluate the draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('history unavailable');
  });

  it('shows per-sample scores, worst fields first, and a drill-down', async () => {
    const iter = iterationView();
    tab({ listIterations: vi.fn(async () => [iter]), getIteration: vi.fn(async () => iter) });
    const samples = await screen.findByRole('table', { name: 'Samples' });
    const a = within(samples).getByText('a.pdf').closest('tr')!;
    expect(within(a).getByText('50%')).toBeInTheDocument();
    expect(within(a).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '#/review/j1');
    const accuracy = screen.getByRole('table', { name: 'Field accuracy' });
    const [first] = within(accuracy).getAllByRole('row').slice(1);
    expect(first).toHaveTextContent('sent_on');
    expect(first).toHaveTextContent('1 / 2');
    await userEvent.click(within(a).getByRole('button', { name: 'Details' }));
    const detail = screen.getByRole('table', { name: 'Fields in a.pdf' });
    const row = within(detail).getByText('sent_on').closest('tr')!;
    expect(row).toHaveTextContent('2026-03-01');
    expect(row).toHaveTextContent('2026-01-03');
  });

  it('restores an iteration from the history after confirming', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const iter = iterationView();
    const { api, onRestored } = tab({
      listIterations: vi.fn(async () => [iter]),
      getIteration: vi.fn(async () => iter),
      restoreIteration: vi.fn(async () => projectView()),
    });
    const history = await screen.findByRole('table', { name: 'History' });
    await userEvent.click(within(history).getByRole('button', { name: 'Restore' }));
    expect(confirm).toHaveBeenCalled();
    expect(api.restoreIteration).toHaveBeenCalledWith('letter', iter.id);
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    confirm.mockRestore();
  });

  it('needs an open draft', async () => {
    tab({}, false);
    expect(await screen.findByRole('button', { name: 'Evaluate the draft' })).toBeDisabled();
  });
});
