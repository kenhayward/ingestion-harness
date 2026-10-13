import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OverviewItem, TestRun } from '@ih/shared';
import { ApiError } from '../src/api/client.js';
import { RunsTab } from '../src/workbench/RunsTab.js';
import { fakeApi, sampleView, testRunView } from './fake-api.js';

const item: OverviewItem = {
  stage: 'runs',
  state: 'running',
  status: '2 test runs in progress · 1 awaiting review',
  metrics: [],
};
const ready = (n: number) =>
  sampleView({ id: `00000000-0000-4000-8000-00000000000${n}`, filename: `s${n}.pdf` });
const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();

function tab(api = fakeApi(), props: Partial<Parameters<typeof RunsTab>[0]> = {}) {
  const onChanged = vi.fn();
  render(
    <RunsTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      draft={4}
      item={item}
      pollMs={60_000}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { api, onChanged };
}
const runButton = () => screen.findByRole('button', { name: /^Run on \d+ dev samples?$/ });

describe('RunsTab', () => {
  it('heads the tab with the status line and what test runs are', async () => {
    tab();
    expect(await screen.findByRole('heading', { level: 2, name: 'Test runs' })).toBeInTheDocument();
    expect(screen.getByText('2 test runs in progress · 1 awaiting review')).toBeInTheDocument();
    expect(screen.getByText(/Runs draft v4 on prepared dev samples/)).toHaveTextContent(
      "Test runs aren't scored (Evaluate compares with references), holdout samples are never used",
    );
  });

  it('ticks every ready dev sample; preparing and failed ones cannot be picked, with a reason', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          ready(1),
          ready(2),
          sampleView({ filename: 'h.pdf', role: 'holdout' }),
          sampleView({ filename: 'p.pdf', state: 'preparing' }),
          sampleView({
            filename: 'f.pdf',
            state: 'failed',
            prepareError: { code: 'corrupt', message: 'PDF could not be read' },
          }),
        ]),
      }),
    );
    expect(await screen.findByRole('checkbox', { name: 's1.pdf' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 's2.pdf' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'h.pdf' })).toBeNull();
    const preparing = screen.getByRole('checkbox', { name: 'p.pdf' });
    expect(preparing).toBeDisabled();
    expect(preparing).not.toBeChecked();
    expect(preparing).toHaveAttribute('title', 'Still preparing');
    expect(screen.getByRole('checkbox', { name: 'f.pdf' })).toHaveAttribute(
      'title',
      'Preparation failed: PDF could not be read',
    );
    expect(await runButton()).toHaveTextContent('Run on 2 dev samples');
  });

  it('the selection count drives the button label; none selected disables it with a reason', async () => {
    tab(fakeApi({ listSamples: vi.fn(async () => [ready(1), ready(2)]) }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 's1.pdf' }));
    expect(await runButton()).toHaveTextContent('Run on 1 dev sample');
    await userEvent.click(screen.getByRole('checkbox', { name: 's2.pdf' }));
    const button = await runButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Select at least one prepared dev sample');
  });

  it('does not claim zero samples before the first load', async () => {
    let release: (s: ReturnType<typeof ready>[]) => void = () => {};
    tab(
      fakeApi({
        listSamples: vi.fn(
          () =>
            new Promise<ReturnType<typeof ready>[]>((resolve) => {
              release = resolve;
            }),
        ),
      }),
    );
    const loading = screen.getByRole('button', { name: 'Run on dev samples' });
    expect(loading).toBeDisabled();
    expect(loading).toHaveAttribute('title', 'Loading samples…');
    release([ready(1), ready(2)]);
    expect(await runButton()).toHaveTextContent('Run on 2 dev samples');
  });

  describe('a sample that becomes ready while the tab is open', () => {
    // Sample 3 is preparing at first, so the tab keeps polling until it is ready.
    function withPreparingSample() {
      const samples = [
        ready(1),
        ready(2),
        sampleView({ id: ready(3).id, filename: 's3.pdf', state: 'preparing' }),
      ];
      tab(fakeApi({ listSamples: vi.fn(async () => [...samples]) }), { pollMs: 20 });
      return () => {
        samples[2] = ready(3);
      };
    }

    it('joins an untouched selection', async () => {
      const becomeReady = withPreparingSample();
      expect(await runButton()).toHaveTextContent('Run on 2 dev samples');
      becomeReady();
      await waitFor(() => expect(screen.getByRole('checkbox', { name: 's3.pdf' })).toBeChecked());
      expect(await runButton()).toHaveTextContent('Run on 3 dev samples');
    });

    it('stays off once the user has changed the selection', async () => {
      const becomeReady = withPreparingSample();
      await userEvent.click(await screen.findByRole('checkbox', { name: 's1.pdf' }));
      expect(await runButton()).toHaveTextContent('Run on 1 dev sample');
      becomeReady();
      await waitFor(() => expect(screen.getByRole('checkbox', { name: 's3.pdf' })).toBeEnabled());
      expect(screen.getByRole('checkbox', { name: 's3.pdf' })).not.toBeChecked();
      expect(await runButton()).toHaveTextContent('Run on 1 dev sample');
    });
  });

  it('cannot run without an open draft, and says why', async () => {
    tab(fakeApi({ listSamples: vi.fn(async () => [ready(1)]) }), { draft: null });
    const button = await runButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'Every version is published: start the next version on the Template tab first',
    );
  });

  it('runs the selected samples with the picked model choice, then reloads', async () => {
    const queued = testRunView({
      batchId: 'b1',
      filename: 's2.pdf',
      specVersion: 4,
      status: 'queued',
      createdAt: at(0),
    });
    const listTestRuns = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([queued]);
    const api = fakeApi({
      listSamples: vi.fn(async () => [ready(1), ready(2)]),
      listTestRuns,
      runDevTests: vi.fn(async () => ({ jobs: [queued] })),
    });
    const { onChanged } = tab(api);
    await userEvent.click(await screen.findByRole('checkbox', { name: 's1.pdf' }));
    await userEvent.click(await runButton());
    const dialog = screen.getByRole('dialog', { name: 'Run v4 on 1 dev sample' });
    const model = within(dialog).getByRole('combobox', { name: 'Model' });
    expect(model).toHaveValue('');
    // A local-only project cannot pick an external model choice.
    expect(
      (within(model).getByRole('option', { name: /Cloud model/ }) as HTMLOptionElement).disabled,
    ).toBe(true);
    await userEvent.selectOptions(model, 'New for testing only');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run' }));
    expect(api.runDevTests).toHaveBeenCalledWith('letter', {
      model: 'test',
      sampleIds: ['00000000-0000-4000-8000-000000000002'],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('region', { name: /draft v4/ })).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps a refusal in the dialog', async () => {
    const api = fakeApi({
      listSamples: vi.fn(async () => [ready(1)]),
      runDevTests: vi.fn(async () => {
        throw new ApiError('s1.pdf is not prepared yet', 409);
      }),
    });
    tab(api);
    await userEvent.click(await runButton());
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('s1.pdf is not prepared yet');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the queue line', async () => {
    tab(
      fakeApi({ getQueueSummary: vi.fn(async () => ({ ahead: 3, running: 1, etaSeconds: 120 })) }),
    );
    expect(await screen.findByText('Queue: 3 jobs ahead · about 2 min')).toBeInTheDocument();
  });

  it('keeps the tab when the queue cannot be read', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [ready(1)]),
        getQueueSummary: vi.fn(async () => {
          throw new Error('down');
        }),
      }),
    );
    expect(await runButton()).toBeEnabled();
    expect(screen.queryByText(/^Queue:/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists batches newest first and keeps older ones behind Show', async () => {
    const runs: TestRun[] = [1, 2, 3].map((n) =>
      testRunView({
        batchId: `b${n}`,
        filename: `s${n}.pdf`,
        status: 'succeeded',
        createdAt: at(n),
        specVersion: n + 1,
      }),
    );
    tab(fakeApi({ listTestRuns: vi.fn(async () => runs) }));
    const regions = await screen.findAllByRole('region', { name: /· draft v/ });
    expect(regions.map((r) => r.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/draft v4$/),
      expect.stringMatching(/draft v3$/),
    ]);
    expect(screen.getByText('Older batches: 1 more on v2')).toBeInTheDocument();
    const show = screen.getByRole('button', { name: 'Show' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(show);
    expect(screen.getAllByRole('region', { name: /· draft v/ })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps runs outside a batch in a collapsed Other runs list', async () => {
    tab(
      fakeApi({
        listTestRuns: vi.fn(async () => [
          testRunView({ filename: 'ref.pdf', status: 'succeeded' }),
        ]),
      }),
    );
    const show = await screen.findByRole('button', { name: 'Show other runs (1)' });
    expect(screen.queryByRole('cell', { name: 'ref.pdf' })).toBeNull();
    await userEvent.click(show);
    expect(screen.getByRole('cell', { name: 'ref.pdf' })).toBeInTheDocument();
  });

  it('retries a failed run through the re-process dialog', async () => {
    const failed = testRunView({
      batchId: 'b1',
      filename: 's1.pdf',
      status: 'failed',
      modelOverride: null,
    });
    const api = fakeApi({ listTestRuns: vi.fn(async () => [failed]) });
    tab(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry s1.pdf' }));
    const dialog = screen.getByRole('dialog', { name: 'Retry s1.pdf' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(api.retryJob).toHaveBeenCalledWith(failed.id, null);
  });

  it('polls only while a run is active', async () => {
    const running = testRunView({ batchId: 'b1', status: 'running' });
    const idle = vi.fn(async () => [testRunView({ batchId: 'b1', status: 'succeeded' })]);
    tab(fakeApi({ listTestRuns: idle }), { pollMs: 20 });
    await screen.findByRole('region', { name: /draft v/ });
    await new Promise((r) => setTimeout(r, 120));
    expect(idle).toHaveBeenCalledTimes(1);

    const busy = vi.fn(async () => [running]);
    tab(fakeApi({ listTestRuns: busy }), { pollMs: 20 });
    await waitFor(() => expect(busy.mock.calls.length).toBeGreaterThan(2));
  });

  it('tells the page when the last active run finishes', async () => {
    const running = testRunView({ batchId: 'b1', status: 'running' });
    const done = { ...running, status: 'succeeded' as const };
    const listTestRuns = vi.fn().mockResolvedValueOnce([running]).mockResolvedValue([done]);
    const { onChanged } = tab(fakeApi({ listTestRuns }), { pollMs: 20 });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("drops a slower earlier response (another project's runs never replace these)", async () => {
    let slow!: (runs: TestRun[]) => void;
    const mine = testRunView({ batchId: 'b1', filename: 'mine.pdf', status: 'succeeded' });
    const listTestRuns = vi.fn((projectId: string) =>
      projectId === 'letter' ? new Promise<TestRun[]>((r) => (slow = r)) : Promise.resolve([mine]),
    );
    const api = fakeApi({ listTestRuns });
    const props = {
      api,
      dataPolicy: 'local' as const,
      draft: 4,
      item,
      pollMs: 60_000,
      onChanged: vi.fn(),
    };
    const { rerender } = render(<RunsTab {...props} projectId="letter" />);
    rerender(<RunsTab {...props} projectId="other" />);
    expect(await screen.findByRole('cell', { name: 'mine.pdf' })).toBeInTheDocument();
    slow([testRunView({ batchId: 'b9', filename: 'stale.pdf', status: 'succeeded' })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole('cell', { name: 'mine.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'stale.pdf' })).toBeNull();
  });
});
