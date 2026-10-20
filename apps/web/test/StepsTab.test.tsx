import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DraftChange } from '@ih/shared';
import { StagePanel } from '../src/workbench/StagePanel.js';
import { changeProposalView, fakeApi, templateView } from './fake-api.js';

const BEFORE = {
  id: 'letter',
  version: 4,
  name: 'Letter',
  document: {
    sections: [
      { id: 'header', anchor: '^INVOICE' },
      { id: 'totals', anchor: 'Total' },
      { id: 'payment', anchor: 'Pay' },
    ],
  },
  outputs: {
    fields: [{ id: 'supplier_name' }, { id: 'due_date', type: 'date' }, { id: 'total' }],
    tables: [],
  },
  pipeline: [
    { type: 'extract', id: 'header', fields: ['supplier_name'], sections: ['header'] },
    { type: 'extract', id: 'totals', fields: ['total'], sections: ['totals', 'payment'] },
  ],
};
const HEADER = {
  type: 'extract',
  id: 'header',
  fields: ['supplier_name', 'due_date'],
  sections: ['header'],
};
const CHECK = { type: 'check', id: 'totals-match', values: 'total', reference: 'total' };
const AFTER = { ...BEFORE, pipeline: [HEADER, BEFORE.pipeline[1], CHECK] };
const PROPOSAL = changeProposalView({
  stage: 'steps',
  body: {
    notes: 'Adds due_date to the header step.',
    changes: [
      { op: 'putStep', reason: 'due_date has no step', step: HEADER },
      { op: 'putStep', reason: 'Catches dropped lines', step: CHECK },
    ] as unknown as DraftChange[],
  },
});
const METRICS = {
  templateId: 'letter',
  versions: [],
  topEdited: [],
  steps: [
    {
      stepId: 'header',
      runs: 18,
      reruns: 0,
      failures: 0,
      avgAttempts: 1.1,
      avgOutputTokens: null,
      avgSeconds: 6,
    },
    {
      stepId: 'totals',
      runs: 18,
      reruns: 0,
      failures: 0,
      avgAttempts: 2,
      avgOutputTokens: null,
      avgSeconds: 5,
    },
  ],
};

function stepsPanel(metrics = METRICS, definition: Record<string, unknown> = BEFORE) {
  let current: Record<string, unknown> = definition;
  const api = fakeApi({
    listProposals: vi.fn(async () => [PROPOSAL]),
    getTemplate: vi.fn(async () => templateView(current)),
    getMetrics: vi.fn(async () => metrics),
    decideProposal: vi.fn(async () => {
      current = AFTER;
      return { ...PROPOSAL, status: 'accepted' as const, acceptedChanges: [0, 1] };
    }),
  });
  render(
    <StagePanel
      api={api}
      projectId="letter"
      stage="steps"
      title="Extraction steps"
      dataPolicy="local"
      hasDraft
      draft={4}
      published={null}
      pollMs={1}
      onApplied={vi.fn()}
      onSkipped={vi.fn()}
    />,
  );
  return api;
}

describe('Steps tab', () => {
  it('draws a plugin step with the plugin it runs and no model', async () => {
    const plugin = {
      type: 'plugin',
      id: 'totals',
      uses: 'text.pattern@1',
      fields: ['total'],
      sections: ['totals'],
    };
    stepsPanel(METRICS, { ...BEFORE, pipeline: [BEFORE.pipeline[0], plugin] });
    const card = await screen.findByRole('listitem', { name: 'Step 2: totals' });
    expect(within(card).getByText('PLUGIN')).toBeInTheDocument();
    expect(within(card).getByText('text.pattern@1')).toBeInTheDocument();
    expect(within(card).getByText('total')).toBeInTheDocument();
  });

  it('shows which step fills each output and whether the proposal fixes the gaps', async () => {
    stepsPanel();
    expect(
      await screen.findByText('1 output not filled by any step — the proposal fixes it'),
    ).toBeInTheDocument();
    const gap = screen.getByText(': not filled by any step').closest('li')!;
    expect(gap).toHaveAttribute('data-tone', 'warn');
    expect(within(gap).getByText('due_date')).toBeInTheDocument();
    expect(screen.getByText(': step 1').closest('li')).toHaveTextContent('supplier_name');
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Apply: EXTRACT header fills supplier_name, due_date from header',
      }),
    );
    expect(
      screen.getByText('1 output not filled by any step — the proposal does not fix it'),
    ).toBeInTheDocument();
  });

  it('names the repeating section a step runs over and its key column', async () => {
    const repeating = {
      ...BEFORE,
      document: {
        sections: [
          { id: 'header', anchor: '^INVOICE' },
          { id: 'totals', anchor: 'Total', repeat: true, key: 'Batch (.+)' },
          { id: 'payment', anchor: 'Pay' },
        ],
      },
      outputs: {
        fields: [{ id: 'supplier_name' }],
        tables: [{ id: 'sums', columns: [{ id: 'batch' }] }],
      },
      pipeline: [
        BEFORE.pipeline[0],
        { type: 'extract', id: 'totals', table: 'sums', sections: ['totals'], keyColumn: 'batch' },
      ],
    };
    stepsPanel(METRICS, repeating);
    const totals = await screen.findByRole('listitem', { name: 'Step 2: totals' });
    expect(within(totals).getByText('Once per totals · batch from its key')).toBeInTheDocument();
    const header = screen.getByRole('listitem', { name: 'Step 1: header' });
    expect(within(header).queryByText(/^Once per/)).toBeNull();
  });

  it('draws the pipeline with sections, figures and a retry warning', async () => {
    stepsPanel();
    expect(await screen.findByText('Prepared text, split into 3 sections')).toBeInTheDocument();
    const totals = screen.getByRole('listitem', { name: 'Step 2: totals' });
    expect(within(totals).getByText('EXTRACT')).toBeInTheDocument();
    expect(await within(totals).findByText('Main Production Model')).toBeInTheDocument();
    expect(within(totals).getByText('payment')).toBeInTheDocument();
    expect(within(totals).getByText('2.0')).toBeInTheDocument();
    expect(within(totals).getByText(/^Needs a retry on many runs/)).toBeInTheDocument();
    const header = screen.getByRole('listitem', { name: 'Step 1: header' });
    expect(within(header).getByText('1.1')).toBeInTheDocument();
    expect(within(header).queryByText(/Needs a retry/)).toBeNull();
    expect(screen.getByText('Outputs: 3 fields')).toBeInTheDocument();
  });

  it("opens a retrying step's model log from its warning", async () => {
    const api = stepsPanel();
    const totals = await screen.findByRole('listitem', { name: 'Step 2: totals' });
    await userEvent.click(within(totals).getByRole('button', { name: 'See the model log' }));
    expect(await screen.findByRole('dialog', { name: 'Model log: totals' })).toBeInTheDocument();
    expect(api.listRetriedStepRuns).toHaveBeenCalledWith('letter', 'totals');
    const header = screen.getByRole('listitem', { name: 'Step 1: header' });
    expect(within(header).queryByRole('button', { name: 'See the model log' })).toBeNull();
  });

  it('links to the Recipe tab, where steps are edited by hand', async () => {
    stepsPanel();
    const pipeline = await screen.findByRole('region', { name: 'Pipeline in draft v4' });
    expect(
      within(pipeline).getByRole('link', { name: 'Edit steps on the Recipe tab' }),
    ).toHaveAttribute('href', '#/workbench/letter/template');
  });

  it('marks the steps the proposal added and turns coverage green once applied', async () => {
    const api = stepsPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Apply 2 selected changes' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', PROPOSAL.id, 'accepted', [0, 1]);
    const added = await screen.findByRole('listitem', { name: 'Step 3: totals-match' });
    expect(within(added).getByText('JUST ADDED')).toBeInTheDocument();
    expect(within(added).getByText('CHECK')).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: 'Step 1: header' })).queryByText('JUST ADDED'),
    ).toBeNull();
    expect(screen.getByText('Every output is filled by exactly one step')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: '2 of 2 changes applied to draft v4' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Run on dev samples' })).toHaveAttribute(
      'href',
      '#/workbench/letter/runs',
    );
  });

  it('clears JUST ADDED when a new proposal is requested', async () => {
    const api = stepsPanel();
    api.startStage = vi.fn(async () => PROPOSAL);
    await userEvent.click(await screen.findByRole('button', { name: 'Apply 2 selected changes' }));
    expect(
      within(await screen.findByRole('listitem', { name: 'Step 3: totals-match' })).getByText(
        'JUST ADDED',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Propose again' }));
    await waitFor(() => expect(api.startStage).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('JUST ADDED')).toBeNull());
  });

  it('ignores step figures from a draft that was superseded while loading', async () => {
    let resolveSlow!: (m: typeof METRICS) => void;
    const slow = new Promise<typeof METRICS>((res) => (resolveSlow = res));
    const getMetrics = vi.fn().mockReturnValueOnce(slow).mockResolvedValue(METRICS);
    const api = fakeApi({
      listProposals: vi.fn(async () => []),
      getTemplate: vi.fn(async () => templateView(BEFORE)),
      getMetrics,
    });
    const props = {
      api,
      projectId: 'letter',
      stage: 'steps' as const,
      title: 'Extraction steps',
      dataPolicy: 'local' as const,
      hasDraft: true,
      published: null,
      pollMs: 1,
      onApplied: vi.fn(),
      onSkipped: vi.fn(),
    };
    const { rerender } = render(<StagePanel {...props} draft={4} />);
    rerender(<StagePanel {...props} draft={5} />);
    const header = await screen.findByRole('listitem', { name: 'Step 1: header' });
    expect(await within(header).findByText('1.1')).toBeInTheDocument();
    await act(async () =>
      resolveSlow({
        ...METRICS,
        steps: [{ ...METRICS.steps[0]!, avgAttempts: 1.7 }, METRICS.steps[1]!],
      }),
    );
    expect(within(header).getByText('1.1')).toBeInTheDocument();
    expect(within(header).queryByText('1.7')).toBeNull();
  });

  it('says when a step has no runs yet', async () => {
    stepsPanel({ ...METRICS, steps: [METRICS.steps[0]!] });
    const totals = await screen.findByRole('listitem', { name: 'Step 2: totals' });
    expect(within(totals).getByText('No runs yet.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: 'Step 1: header' })).queryByText('No runs yet.'),
    ).toBeNull();
  });
});
