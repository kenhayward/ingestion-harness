import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EvaluateTab } from '../src/workbench/EvaluateTab.js';
import { fakeApi, feedbackItem, gateView, iterationView, projectView } from './fake-api.js';

function tab(overrides = {}, hasDraft = true) {
  const api = fakeApi({ getProject: vi.fn(async () => projectView()), ...overrides });
  const onRestored = vi.fn();
  render(
    <EvaluateTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      hasDraft={hasDraft}
      draft={hasDraft ? 2 : null}
      pollMs={1}
      onRestored={onRestored}
    />,
  );
  return { api, onRestored };
}

describe('EvaluateTab', () => {
  it('passes "fresh model calls" to evaluate', async () => {
    const it0 = iterationView({ status: 'running', score: null });
    const { api } = tab({
      listIterations: vi.fn(async () => []),
      startEvaluation: vi.fn(async () => it0),
      getIteration: vi.fn(async () => it0),
    });
    await userEvent.click(await screen.findByLabelText('Fresh model calls (skip the step cache)'));
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate the draft' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', null, {
      uncached: true,
      set: 'dev',
    });
  });

  it('tells the page once an evaluation or a comparison has started', async () => {
    const it0 = iterationView({ status: 'running', score: null });
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      listIterations: vi.fn(async () => []),
      startEvaluation: vi.fn(async () => it0),
      getIteration: vi.fn(async () => it0),
      startComparison: vi.fn(async () => ({ groupId: 'g1', iterations: [] })),
    });
    const onStarted = vi.fn();
    render(
      <EvaluateTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        hasDraft
        draft={2}
        pollMs={60_000}
        onRestored={vi.fn()}
        onStarted={onStarted}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Compare models' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate the draft' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
  });

  it('does not tell the page when starting an evaluation fails', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      listIterations: vi.fn(async () => []),
      startEvaluation: vi.fn(async () => {
        throw new Error('no ready dev samples');
      }),
    });
    const onStarted = vi.fn();
    render(
      <EvaluateTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        hasDraft
        draft={2}
        pollMs={60_000}
        onRestored={vi.fn()}
        onStarted={onStarted}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Evaluate the draft' }));
    expect(await screen.findByText('no ready dev samples')).toBeInTheDocument();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('evaluates the holdout set, which cannot be compared across models', async () => {
    const it0 = iterationView({ status: 'running', score: null, set: 'holdout' });
    const { api } = tab({
      listIterations: vi.fn(async () => []),
      startEvaluation: vi.fn(async () => it0),
      getIteration: vi.fn(async () => it0),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Set'), 'holdout');
    expect(screen.getByRole('button', { name: 'Compare models' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate the draft' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', null, {
      uncached: false,
      set: 'holdout',
    });
  });

  it('marks holdout iterations in the history', async () => {
    const dev = iterationView();
    const holdout = iterationView({ set: 'holdout' });
    tab({
      listIterations: vi.fn(async () => [holdout, dev]),
      getIteration: vi.fn(async () => holdout),
    });
    const history = await screen.findByRole('table', { name: 'History' });
    const rows = within(history).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('holdout');
    expect(rows[2]).not.toHaveTextContent('holdout');
  });

  it('shows the publish panel only for an open draft', async () => {
    tab({ getPublishGate: vi.fn(async () => gateView({ reason: 'gate reason' })) });
    expect(
      await screen.findByText(/^Gate reason. References and evaluation are optional/),
    ).toBeInTheDocument();
  });

  it('keeps the publish panel without an open draft, with no Publish button', async () => {
    tab({}, false);
    expect(
      await screen.findByText(
        'Every version is published; start the next version on the Template tab',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Publish v/ })).toBeNull();
  });

  it('reloads the publish gate when the latest evaluation completes', async () => {
    const running = iterationView({ status: 'running', score: null, set: 'holdout' });
    const done = iterationView({ id: running.id, status: 'complete', set: 'holdout' });
    const getIteration = vi.fn().mockResolvedValueOnce(running).mockResolvedValue(done);
    const { api } = tab({ listIterations: vi.fn(async () => [running]), getIteration });
    await waitFor(() => expect(getIteration.mock.calls.length).toBeGreaterThan(1));
    // Once on mount, once when the running iteration loads, once when it completes.
    await waitFor(() => expect(api.getPublishGate).toHaveBeenCalledTimes(3));
  });

  it('comments on a field from the drill-down', async () => {
    const latest = iterationView();
    const { api } = tab({
      listIterations: vi.fn(async () => [latest]),
      getIteration: vi.fn(async () => latest),
      addFeedback: vi.fn(async () => feedbackItem()),
    });
    const samples = await screen.findByRole('table', { name: 'Samples' });
    await userEvent.click(
      within(within(samples).getByText('a.pdf').closest('tr')!).getByRole('button', {
        name: 'Details',
      }),
    );
    const detail = screen.getByRole('table', { name: 'Fields in a.pdf' });
    await userEvent.click(
      within(within(detail).getByText('sent_on').closest('tr')!).getByRole('button', {
        name: 'Comment',
      }),
    );
    await userEvent.type(screen.getByLabelText('Comment on sent_on'), 'Dates are DMY');
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    expect(api.addFeedback).toHaveBeenCalledWith('letter', {
      target: 'field',
      targetId: 'sent_on',
      body: 'Dates are DMY',
      sampleId: 's1',
      iterationId: latest.id,
    });
    expect(await screen.findByText('Comment saved; see the Revise tab')).toBeInTheDocument();
  });

  it('keeps a comment that failed to save and shows why', async () => {
    const latest = iterationView();
    tab({
      listIterations: vi.fn(async () => [latest]),
      getIteration: vi.fn(async () => latest),
      addFeedback: vi.fn(async () =>
        Promise.reject(new Error('feedback can only refer to dev samples')),
      ),
    });
    const samples = await screen.findByRole('table', { name: 'Samples' });
    await userEvent.click(
      within(within(samples).getByText('a.pdf').closest('tr')!).getByRole('button', {
        name: 'Details',
      }),
    );
    const detail = screen.getByRole('table', { name: 'Fields in a.pdf' });
    await userEvent.click(
      within(within(detail).getByText('sent_on').closest('tr')!).getByRole('button', {
        name: 'Comment',
      }),
    );
    const box = screen.getByLabelText('Comment on sent_on');
    expect(box).toHaveAttribute('maxlength', '2000');
    await userEvent.type(box, 'Dates are DMY');
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'feedback can only refer to dev samples',
    );
    expect(screen.getByLabelText('Comment on sent_on')).toHaveValue('Dates are DMY');
    expect(screen.queryByText('Comment saved; see the Revise tab')).toBeNull();
  });

  it('compares model choices side by side, headed by their labels', async () => {
    const group = 'g1';
    const views = [
      iterationView({ model: 'main', groupId: group, score: 0.75 }),
      iterationView({ model: 'test', groupId: group, score: 0.5 }),
      // From before model choices: shown by its name.
      iterationView({ model: 'draft', groupId: group, score: 1 }),
    ];
    const { api } = tab({
      listIterations: vi.fn(async () => []),
      startComparison: vi.fn(async () => ({ groupId: group, iterations: views })),
      getComparison: vi.fn(async () => ({ groupId: group, iterations: views })),
    });
    await screen.findByRole('checkbox', { name: 'New for testing only' });
    await userEvent.click(await screen.findByRole('button', { name: 'Compare models' }));
    // Every choice a local-only project may use (the external one is out).
    expect(api.startComparison).toHaveBeenCalledWith('letter', {
      uncached: false,
      models: ['main', 'test'],
    });
    const table = await screen.findByRole('table', { name: 'Model comparison' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Measure', 'Main Production Model', 'New for testing only', 'draft']);
    const score = within(table).getByText('score').closest('tr')!;
    expect(score).toHaveTextContent('75%');
    expect(score).toHaveTextContent('50%');
    expect(score).toHaveTextContent('100%');
  });

  it('compares the model choices ticked, at least two, never an external one here', async () => {
    const { api } = tab({
      listIterations: vi.fn(async () => []),
      startComparison: vi.fn(async () => ({ groupId: 'g1', iterations: [] })),
    });
    const compared = await screen.findByRole('group', { name: 'Models to compare' });
    const main = await within(compared).findByRole('checkbox', {
      name: 'Main Production Model',
    });
    expect(within(compared).getByRole('checkbox', { name: /Cloud model/ })).toBeDisabled();
    await userEvent.click(main);
    expect(screen.getByRole('button', { name: 'Compare models' })).toBeDisabled();
    await userEvent.click(main);
    await userEvent.click(screen.getByRole('button', { name: 'Compare models' }));
    expect(api.startComparison).toHaveBeenCalledWith('letter', {
      uncached: false,
      models: ['main', 'test'],
    });
  });

  it('offers no external model choice to a local-only project', async () => {
    tab({ listIterations: vi.fn(async () => []) });
    const option = await screen.findByRole('option', { name: /Cloud model/ });
    expect((option as HTMLOptionElement).disabled).toBe(true);
  });

  it('disables "Evaluate the draft" while a comparison is running', async () => {
    const group = 'g1';
    const running = [
      iterationView({ model: 'default', groupId: group, status: 'running', score: null }),
    ];
    tab({
      listIterations: vi.fn(async () => []),
      startComparison: vi.fn(async () => ({ groupId: group, iterations: running })),
      getComparison: vi.fn(async () => ({ groupId: group, iterations: running })),
    });
    const evaluate = await screen.findByRole('button', { name: 'Evaluate the draft' });
    expect(evaluate).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Compare models' }));
    await screen.findByRole('table', { name: 'Model comparison' });
    await waitFor(() => expect(evaluate).toBeDisabled());
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
      listIterations: vi.fn(async () => []),
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
      listIterations: vi.fn(async () => []),
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

  it('says how many steps came from the cache', async () => {
    const latest = iterationView({ cache: { reused: 5, total: 8 } });
    tab({ listIterations: vi.fn(async () => [latest]), getIteration: vi.fn(async () => latest) });
    expect(await screen.findByText('Reused 5 of 8 steps from the cache')).toBeInTheDocument();
  });

  it('marks fresh and compare iterations in the history', async () => {
    const fresh = iterationView({ uncached: true });
    const grouped = iterationView({ groupId: 'g1', model: 'fast' });
    tab({
      listIterations: vi.fn(async () => [fresh, grouped]),
      getIteration: vi.fn(async () => fresh),
    });
    const history = await screen.findByRole('table', { name: 'History' });
    const rows = within(history).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('fresh');
    expect(rows[1]).not.toHaveTextContent('compare');
    expect(rows[2]).toHaveTextContent('compare');
  });

  it('evaluates with the chosen model and polls until complete', async () => {
    const running = iterationView({ status: 'running', score: null, completed: 0 });
    const done = iterationView({ id: running.id });
    const { api } = tab({
      listIterations: vi.fn(async () => []),
      startEvaluation: vi.fn(async () => running),
      getIteration: vi.fn().mockResolvedValueOnce(running).mockResolvedValue(done),
    });
    await screen.findByRole('option', { name: 'New for testing only' });
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'New for testing only');
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate the draft' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', 'test', {
      uncached: false,
      set: 'dev',
    });
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
