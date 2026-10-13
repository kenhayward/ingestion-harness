import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import {
  COMPARE_HOLDOUT_REASON,
  EvaluateTab,
  HOLDOUT_MODEL_REASON,
} from '../src/workbench/EvaluateTab.js';
import { fakeApi, iterationView, projectView } from './fake-api.js';

function tab(overrides: Partial<Api> = {}, draft: number | null = 2, pollMs = 1) {
  const api = fakeApi({ getProject: vi.fn(async () => projectView()), ...overrides });
  const onRestored = vi.fn();
  const onStarted = vi.fn();
  render(
    <EvaluateTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      draft={draft}
      published={draft === null ? 2 : null}
      pollMs={pollMs}
      onRestored={onRestored}
      onStarted={onStarted}
    />,
  );
  return { api, onRestored, onStarted };
}

describe('EvaluateTab', () => {
  it("evaluates the draft on dev with the template's models by default", async () => {
    const it0 = iterationView({ status: 'running', score: null });
    const { api, onStarted } = tab({
      startEvaluation: vi.fn(async () => it0),
      getIteration: vi.fn(async () => it0),
    });
    expect(await screen.findByRole('button', { name: 'Dev' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate v2 on dev' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', null, {
      uncached: false,
      set: 'dev',
    });
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  });

  it('passes the chosen model and fresh model calls on dev', async () => {
    const it0 = iterationView({ status: 'running', score: null });
    const { api } = tab({
      startEvaluation: vi.fn(async () => it0),
      getIteration: vi.fn(async () => it0),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Model'), 'fast');
    await userEvent.click(screen.getByLabelText('Fresh model calls'));
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate v2 on dev' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', 'fast', {
      uncached: true,
      set: 'dev',
    });
  });

  it("holdout forces the template's models and cannot compare models, with reasons", async () => {
    const it0 = iterationView({ status: 'running', score: null, set: 'holdout' });
    const { api } = tab({
      startEvaluation: vi.fn(async () => it0),
      getIteration: vi.fn(async () => it0),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Model'), 'fast');
    await userEvent.click(screen.getByRole('button', { name: 'Holdout' }));
    expect(screen.getByRole('button', { name: 'Holdout' })).toHaveAttribute('aria-pressed', 'true');
    const select = screen.getByLabelText('Model');
    expect(select).toBeDisabled();
    expect(select).toHaveValue('');
    expect(select).toHaveAttribute('title', HOLDOUT_MODEL_REASON);
    const compare = screen.getByRole('button', { name: 'Compare models' });
    expect(compare).toBeDisabled();
    expect(compare).toHaveAttribute('title', COMPARE_HOLDOUT_REASON);
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate v2 on holdout' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', null, {
      uncached: false,
      set: 'holdout',
    });
  });

  it('needs an open draft, and says so', async () => {
    const { api } = tab({}, null);
    const evaluate = await screen.findByRole('button', { name: 'Evaluate on dev' });
    expect(evaluate).toBeDisabled();
    expect(evaluate).toHaveAttribute('title', 'Start a draft version first');
    expect(screen.getByRole('button', { name: 'Compare models' })).toHaveAttribute(
      'title',
      'Start a draft version first',
    );
    await waitFor(() => expect(api.listPublications).toHaveBeenCalled());
    expect(api.getPublishGate).not.toHaveBeenCalled();
    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
  });

  it('shows the latest run of the selected set', async () => {
    const dev = iterationView();
    const holdout = iterationView({ set: 'holdout' });
    const getIteration = vi.fn(async (_p: string, id: string) =>
      id === holdout.id ? holdout : dev,
    );
    tab({ listIterations: vi.fn(async () => [holdout, dev]), getIteration });
    const latest = await screen.findByRole('region', { name: 'Latest run' });
    expect(within(latest).getByRole('heading', { name: /^Latest dev run/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Holdout' }));
    expect(await screen.findByRole('heading', { name: /^Latest holdout run/ })).toBeInTheDocument();
    expect(getIteration).toHaveBeenCalledWith('letter', holdout.id);
  });

  it('feeds the Dev meter from the newest dev run of the draft', async () => {
    const dev = iterationView();
    tab({ listIterations: vi.fn(async () => [dev]), getIteration: vi.fn(async () => dev) });
    const gate = await screen.findByRole('region', { name: 'Publish gate' });
    expect(
      await within(gate).findByRole('img', { name: 'Dev score: 75%, threshold 90%' }),
    ).toBeInTheDocument();
  });

  it('polls while a run is active, then stops', async () => {
    const running = iterationView({ status: 'running', score: null, completed: 0 });
    const done = iterationView({ id: running.id });
    const listIterations = vi.fn().mockResolvedValueOnce([running]).mockResolvedValue([done]);
    const getIteration = vi.fn().mockResolvedValueOnce(running).mockResolvedValue(done);
    tab({ listIterations, getIteration });
    expect(await screen.findByText(/2 of 2 compared/)).toBeInTheDocument();
    const calls = listIterations.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(listIterations.mock.calls.length).toBe(calls);
  });

  it('reloads the publish gate when the latest evaluation completes', async () => {
    const running = iterationView({ status: 'running', score: null, set: 'holdout' });
    const done = iterationView({ id: running.id, status: 'complete', set: 'holdout' });
    const { api } = tab({
      listIterations: vi.fn().mockResolvedValueOnce([running]).mockResolvedValue([done]),
      getIteration: vi.fn().mockResolvedValueOnce(running).mockResolvedValue(done),
    });
    // Once on mount, once when the running iteration is listed, once when it completes.
    await waitFor(() => expect(api.getPublishGate).toHaveBeenCalledTimes(3));
  });

  it('reports a failed history refresh while polling', async () => {
    const running = iterationView({ status: 'running', score: null, completed: 0 });
    tab({
      listIterations: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValue(new Error('history unavailable')),
      startEvaluation: vi.fn(async () => running),
      getIteration: vi.fn(async () => running),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Evaluate v2 on dev' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('history unavailable');
  });

  it('does not tell the page when starting an evaluation fails', async () => {
    const { onStarted } = tab(
      { startEvaluation: vi.fn(async () => Promise.reject(new Error('no ready dev samples'))) },
      2,
      60_000,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Evaluate v2 on dev' }));
    expect(await screen.findByText('no ready dev samples')).toBeInTheDocument();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('compares models side by side and tells the page', async () => {
    const group = 'g1';
    const views = [
      iterationView({ model: 'default', groupId: group, score: 0.75 }),
      iterationView({ model: 'fast', groupId: group, score: 0.5 }),
      iterationView({ model: 'draft', groupId: group, score: 1 }),
    ];
    const { api, onStarted } = tab({
      startComparison: vi.fn(async () => ({ groupId: group, iterations: views })),
      getComparison: vi.fn(async () => ({ groupId: group, iterations: views })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Compare models' }));
    expect(api.startComparison).toHaveBeenCalledWith('letter', { uncached: false });
    const table = await screen.findByRole('table', { name: 'Model comparison' });
    const score = within(table).getByText('score').closest('tr')!;
    expect(score).toHaveTextContent('75%');
    expect(score).toHaveTextContent('50%');
    expect(score).toHaveTextContent('100%');
    expect(onStarted).toHaveBeenCalled();
  });

  it('disables Evaluate while a comparison is running, with a reason', async () => {
    const group = 'g1';
    const running = [
      iterationView({ model: 'default', groupId: group, status: 'running', score: null }),
    ];
    tab(
      {
        startComparison: vi.fn(async () => ({ groupId: group, iterations: running })),
        getComparison: vi.fn(async () => ({ groupId: group, iterations: running })),
      },
      2,
      60_000,
    );
    const evaluate = await screen.findByRole('button', { name: 'Evaluate v2 on dev' });
    expect(evaluate).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Compare models' }));
    // Busy ("Starting…") first, then blocked by the running comparison.
    await waitFor(() =>
      expect(evaluate).toHaveAttribute('title', 'A model comparison is still running'),
    );
    expect(evaluate).toBeDisabled();
  });

  it('polls a running comparison until it completes, then stops', async () => {
    const group = 'g1';
    const running = [
      iterationView({ model: 'default', groupId: group, status: 'running', score: null }),
      iterationView({ model: 'fast', groupId: group, status: 'running', score: null }),
    ];
    const done = running.map((i) => ({ ...i, status: 'complete' as const, score: 0.5 }));
    const getComparison = vi
      .fn()
      .mockResolvedValueOnce({ groupId: group, iterations: running })
      .mockResolvedValue({ groupId: group, iterations: done });
    tab({
      startComparison: vi.fn(async () => ({ groupId: group, iterations: running })),
      getComparison,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Compare models' }));
    const table = await screen.findByRole('table', { name: 'Model comparison' });
    await waitFor(() =>
      expect(within(table).getByText('score').closest('tr')).toHaveTextContent('50%'),
    );
    expect(within(table).queryByText(/running/)).not.toBeInTheDocument();
    const calls = getComparison.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(getComparison.mock.calls.length).toBe(calls);
  });

  it('shows a comparison poll failure and clears it when a poll succeeds', async () => {
    const group = 'g1';
    const running = [iterationView({ model: 'default', groupId: group, status: 'running' })];
    const done = running.map((i) => ({ ...i, status: 'complete' as const }));
    tab({
      startComparison: vi.fn(async () => ({ groupId: group, iterations: running })),
      getComparison: vi
        .fn()
        .mockRejectedValueOnce(new Error('comparison poll failed'))
        .mockResolvedValue({ groupId: group, iterations: done }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Compare models' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('comparison poll failed');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('restores an iteration from the history after confirming', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const iter = iterationView();
    const { api, onRestored } = tab({
      listIterations: vi.fn(async () => [iter]),
      getIteration: vi.fn(async () => iter),
      restoreIteration: vi.fn(async () => projectView()),
    });
    const list = await screen.findByRole('list', { name: 'Evaluations' });
    await userEvent.click(within(list).getByRole('button', { name: 'Restore' }));
    expect(confirm).toHaveBeenCalled();
    expect(api.restoreIteration).toHaveBeenCalledWith('letter', iter.id);
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    confirm.mockRestore();
  });
});
