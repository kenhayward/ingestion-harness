import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DraftChange } from '@ih/shared';
import { ApiError } from '../src/api/client.js';
import { StagePanel } from '../src/workbench/StagePanel.js';
import { changeProposalView, fakeApi, sampleView } from './fake-api.js';

function panel(overrides = {}, props: Partial<Parameters<typeof StagePanel>[0]> = {}) {
  const api = fakeApi(overrides);
  const onApplied = vi.fn();
  const onSkipped = vi.fn();
  const view = render(
    <StagePanel
      api={api}
      projectId="letter"
      stage="outputs"
      dataPolicy="local"
      hasDraft
      pollMs={1}
      onApplied={onApplied}
      onSkipped={onSkipped}
      {...props}
    />,
  );
  return { api, onApplied, onSkipped, container: view.container };
}

describe('StagePanel', () => {
  it('proposes, then applies only the selected changes', async () => {
    const p = changeProposalView();
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...p, status: 'running', body: null }])
      .mockResolvedValue([p]);
    const { api, onApplied } = panel({
      listProposals,
      startStage: vi.fn(async () => ({ ...p, status: 'running' as const, body: null })),
      decideProposal: vi.fn(async () => ({
        ...p,
        status: 'partially_accepted' as const,
        acceptedChanges: [1],
      })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Propose outputs' }));
    expect(api.startStage).toHaveBeenCalledWith('letter', 'outputs');
    const first = await screen.findByRole('checkbox', {
      name: 'Apply: FIELD protocol_number text',
    });
    expect(first).toBeChecked();
    expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeEnabled();
    await userEvent.click(first);
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', p.id, 'accepted', [1]);
    expect(onApplied).toHaveBeenCalled();
    expect(await screen.findByText(/1 of 2 changes applied/)).toBeInTheDocument();
  });

  it("opens a proposal's model log, from the card and from a failed run", async () => {
    const p = changeProposalView();
    const log = {
      stage: 'outputs' as const,
      model: 'local/qwen',
      tools: false,
      legacy: false,
      rounds: [
        { label: 'draft-outputs', entries: [{ kind: 'prompt' as const, text: 'ctx', images: 0 }] },
      ],
    };
    const { api } = panel({
      listProposals: vi.fn(async () => [p]),
      getProposalLog: vi.fn(async () => log),
    });
    const card = await screen.findByRole('region', { name: 'Proposal' });
    await userEvent.click(within(card).getByRole('button', { name: 'Model log' }));
    expect(await screen.findByRole('dialog', { name: 'Model log' })).toBeInTheDocument();
    expect(api.getProposalLog).toHaveBeenCalledWith('letter', p.id);
  });

  it('offers the model log of a failed run beside its error', async () => {
    const p = changeProposalView({ status: 'failed', body: null, error: 'drafting model refused' });
    panel({ listProposals: vi.fn(async () => [p]) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('drafting model refused');
    expect(within(alert).getByRole('button', { name: 'Model log' })).toBeInTheDocument();
  });

  it('cancels a waiting or running run, then shows it as cancelled', async () => {
    const p = changeProposalView();
    const waiting = {
      ...p,
      status: 'running' as const,
      body: null,
      run: { status: 'queued' as const, since: p.createdAt, progress: null, paused: true },
    };
    const cancelled = { ...p, status: 'failed' as const, body: null, error: 'Cancelled by Ken.' };
    let done = false;
    const { api } = panel({
      // The panel polls while a run waits: it reads as cancelled only once cancelled.
      listProposals: vi.fn(async () => [done ? cancelled : waiting]),
      cancelProposal: vi.fn(async () => {
        done = true;
        return cancelled;
      }),
    });
    const progress = await screen.findByRole('group', { name: 'Drafting progress' });
    expect(within(progress).getByText(/The job queue is paused/)).toBeInTheDocument();
    await userEvent.click(within(progress).getByRole('button', { name: 'Cancel run' }));
    expect(api.cancelProposal).toHaveBeenCalledWith('letter', p.id);
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancelled by Ken.');
  });

  it('accepts a run that proposes no changes, sending none', async () => {
    const p = changeProposalView({ body: { notes: 'Nothing to add.', changes: [] } });
    const { api, onApplied } = panel({
      listProposals: vi.fn(async () => [p]),
      decideProposal: vi.fn(async () => ({
        ...p,
        status: 'accepted' as const,
        acceptedChanges: [],
      })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept: no changes needed' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', p.id, 'accepted', []);
    expect(onApplied).toHaveBeenCalled();
    expect(await screen.findByText('Accepted: no changes needed')).toBeInTheDocument();
  });

  it('rejects all', async () => {
    const p = changeProposalView();
    const { api } = panel({
      listProposals: vi.fn(async () => [p]),
      decideProposal: vi.fn(async () => ({ ...p, status: 'rejected' as const })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Reject all' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', p.id, 'rejected');
  });

  it('shows a conflict from the API', async () => {
    panel({
      listProposals: vi.fn(async () => [changeProposalView()]),
      decideProposal: vi.fn(async () => {
        throw new ApiError(
          'the draft changed since this proposal where these changes apply: 2; re-run the stage or accept the others',
          409,
        );
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Apply 2 selected changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'the draft changed since this proposal',
    );
  });

  it('needs an open draft', async () => {
    panel({}, { hasDraft: false });
    expect(await screen.findByRole('button', { name: 'Propose outputs' })).toBeDisabled();
    expect(screen.getByText('Start the next version on the Recipe tab first.')).toBeInTheDocument();
  });

  it('hides the skip button when the stage cannot be skipped', async () => {
    panel({}, { canSkip: false });
    await screen.findByRole('button', { name: 'Propose outputs' });
    expect(screen.queryByRole('button', { name: 'Skip this stage' })).toBeNull();
  });

  it('skips the stage', async () => {
    const { api, onSkipped } = panel({ skipStage: vi.fn(async () => []) });
    await userEvent.click(await screen.findByRole('button', { name: 'Skip this stage' }));
    expect(api.skipStage).toHaveBeenCalledWith('letter', 'outputs');
    await waitFor(() => expect(onSkipped).toHaveBeenCalled());
  });

  it('ignores a second click while a decision is pending', async () => {
    const p = changeProposalView();
    let release: (v: typeof p) => void = () => {};
    const decideProposal = vi.fn(
      () =>
        new Promise<typeof p>((resolve) => {
          release = resolve;
        }),
    );
    panel({ listProposals: vi.fn(async () => [p]), decideProposal });
    const apply = await screen.findByRole('button', { name: 'Apply 2 selected changes' });
    await userEvent.click(apply);
    expect(apply).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip this stage' })).toBeDisabled();
    await userEvent.click(apply);
    expect(decideProposal).toHaveBeenCalledTimes(1);
    release({ ...p, status: 'accepted' as const });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reject all' })).toBeNull());
  });

  it('keeps the tab header when the proposals cannot be loaded', async () => {
    panel(
      { listProposals: vi.fn().mockRejectedValue(new Error('network down')) },
      { stage: 'steps', title: 'Extraction pipeline' },
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Extraction pipeline' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('toggles a change when its text is clicked', async () => {
    panel({ listProposals: vi.fn(async () => [changeProposalView()]) });
    // Wait for the selection effect (select all) to run before toggling.
    await screen.findByRole('button', { name: 'Apply 2 selected changes' });
    const box = (await screen.findAllByRole('checkbox'))[0]!;
    expect(box).toBeChecked();
    const text = box.closest('li')!.querySelector('label')!;
    await userEvent.click(text);
    expect(box).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Apply 1 selected change' })).toBeInTheDocument();
  });

  it('offers a retry when the proposals cannot be loaded', async () => {
    const p = changeProposalView();
    const listProposals = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue([p]);
    panel({ listProposals });
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Apply 2 selected changes' })).toBeEnabled();
    expect(listProposals).toHaveBeenCalledTimes(2);
  });

  it('shows where proposed anchors were found on the dev samples', async () => {
    const a = sampleView({ id: 'sa', filename: 'a.pdf' });
    const b = sampleView({ id: 'sb', filename: 'b.pdf' });
    const p = changeProposalView({
      stage: 'sections',
      body: {
        notes: '',
        changes: [
          {
            op: 'putSection',
            section: { id: 'approval', anchor: '^PROTOCOL APPROVAL', required: false },
            reason: 'r',
          },
        ],
        anchorCheck: {
          anchorErrors: {},
          suggestions: [],
          samples: [
            {
              sampleId: 'sa',
              firstPage: 1,
              pageCount: 1,
              error: null,
              missingRequired: [],
              sections: [
                { id: 'approval', found: true, page: 1, line: 'PROTOCOL APPROVAL', chars: 10 },
              ],
            },
            {
              sampleId: 'sb',
              firstPage: 1,
              pageCount: 1,
              error: null,
              missingRequired: [],
              sections: [{ id: 'approval', found: false, page: null, line: null, chars: 0 }],
            },
          ],
        },
      },
    });
    panel(
      { listProposals: vi.fn(async () => [p]), listSamples: vi.fn(async () => [a, b]) },
      { stage: 'sections' },
    );
    const item = (
      await screen.findByRole('checkbox', { name: /^Apply: SECTION approval/ })
    ).closest('li')!;
    expect(
      await within(item).findByText('found in 1 of 2 dev samples (missed: b.pdf)'),
    ).toBeInTheDocument();
  });

  it('cannot apply when no change is selected', async () => {
    panel({ listProposals: vi.fn(async () => [changeProposalView()]) });
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Apply: FIELD protocol_number text' }),
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Apply: FIELD approved_on date' }));
    expect(screen.getByRole('button', { name: 'Apply 0 selected changes' })).toBeDisabled();
  });

  it('puts the title, the status and the actions in the tab header', async () => {
    panel(
      { listProposals: vi.fn(async () => [changeProposalView({ stage: 'steps' })]) },
      {
        stage: 'steps',
        title: 'Extraction pipeline',
        item: { stage: 'steps', state: 'proposed', status: 'Needs your decision', metrics: [] },
      },
    );
    await screen.findByRole('button', { name: 'Propose again' });
    const header = screen
      .getByRole('heading', { level: 2, name: 'Extraction pipeline' })
      .closest('header')!;
    expect(header).not.toBeNull();
    expect(
      within(header).getByRole('heading', { level: 2, name: 'Extraction pipeline' }),
    ).toBeInTheDocument();
    expect(within(header).getByText('Needs your decision')).toBeInTheDocument();
    expect(
      within(header).getByText('Runs on local models; holdout samples are never sent.'),
    ).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Propose again' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Skip this stage' })).toBeInTheDocument();
  });

  it('makes Propose the primary action before the first proposal', async () => {
    panel({ listProposals: vi.fn(async () => []) });
    expect(await screen.findByRole('button', { name: 'Propose outputs' })).toHaveClass('primary');
  });

  it('makes Propose again a plain button once a proposal exists', async () => {
    panel({ listProposals: vi.fn(async () => [changeProposalView()]) });
    expect(await screen.findByRole('button', { name: 'Propose again' })).not.toHaveClass('primary');
  });

  it('shows a decided proposal as the applied card, bordered in its tone', async () => {
    const p = changeProposalView({ status: 'partially_accepted', acceptedChanges: [0] });
    panel({ listProposals: vi.fn(async () => [p]) });
    const region = await screen.findByRole('region', { name: 'Proposal' });
    expect(within(region).getByText(/1 of 2 changes applied/)).toBeInTheDocument();
    expect(within(region).getByText('Applied').closest('li')).toHaveTextContent('protocol_number');
    expect(within(region).getByText('Not applied').closest('li')).toHaveTextContent('approved_on');
    expect(within(region).queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Reject all' })).toBeNull();
    expect(region.style.borderColor).toBe('var(--ih-ok-fg)');
  });

  it('points to the next tab once applied', async () => {
    const p = changeProposalView({ status: 'accepted', acceptedChanges: [0, 1] });
    panel({ listProposals: vi.fn(async () => [p]) });
    expect(await screen.findByRole('link', { name: 'Go to Sections' })).toHaveAttribute(
      'href',
      '#/workbench/letter/sections',
    );
  });

  it('after steps, says test runs refresh the figures but only Evaluate scores', async () => {
    const p = changeProposalView({ stage: 'steps', status: 'accepted', acceptedChanges: [0, 1] });
    panel({ listProposals: vi.fn(async () => [p]) }, { stage: 'steps' });
    expect(await screen.findByRole('link', { name: 'Run on dev samples' })).toHaveAttribute(
      'href',
      '#/workbench/letter/runs',
    );
    expect(screen.getByRole('region', { name: 'Proposal' })).toHaveTextContent(
      "Run the steps on the dev samples to refresh the per-step figures. Test runs aren't scored: Evaluate on dev scores the draft against your verified references.",
    );
  });

  it('links to the Template tab for edits by hand', async () => {
    panel({ listProposals: vi.fn(async () => [changeProposalView()]) });
    expect(
      await screen.findByRole('link', { name: 'Edit by hand on the Recipe tab' }),
    ).toHaveAttribute('href', '#/workbench/letter/template');
  });

  it('tags each change with its kind', async () => {
    // Only the step parts the card shows; the rest of the step schema does not matter here.
    const changes = [
      {
        op: 'putStep',
        reason: 'header block',
        step: { type: 'extract', id: 'header', fields: ['sender'], sections: ['header'] },
      },
      {
        op: 'putStep',
        reason: 'totals',
        step: { type: 'check', id: 'totals', values: 'items.amount', reference: 'total' },
      },
    ] as unknown as DraftChange[];
    panel(
      {
        listProposals: vi.fn(async () => [
          changeProposalView({ stage: 'steps', body: { notes: '', changes } }),
        ]),
      },
      { stage: 'steps' },
    );
    const extract = (
      await screen.findByRole('checkbox', { name: /^Apply: EXTRACT header/ })
    ).closest('li')!;
    expect(within(extract).getByText('EXTRACT')).toBeInTheDocument();
    expect(within(extract).getByText('header block')).toBeInTheDocument();
    const check = screen.getByRole('checkbox', { name: /^Apply: CHECK totals/ }).closest('li')!;
    expect(within(check).getByText('CHECK')).toBeInTheDocument();
    expect(within(check).getByText('items.amount against total')).toBeInTheDocument();
  });

  it('keeps a stale stage without a new proposal', async () => {
    const onConfirmed = vi.fn();
    const { api, onApplied } = panel(
      {
        listProposals: vi.fn(async () => [
          changeProposalView({ stage: 'sections', status: 'accepted' }),
        ]),
        confirmStage: vi.fn(async () => []),
      },
      {
        stage: 'sections',
        title: 'Sections',
        item: {
          stage: 'sections',
          state: 'stale',
          status: 'Stale — Outputs changed after it was accepted',
          metrics: [],
        },
        onConfirmed,
      },
    );
    const banner = await screen.findByRole('note');
    expect(banner).toHaveTextContent('Stale — Outputs changed after it was accepted.');
    await userEvent.click(within(banner).getByRole('button', { name: 'Keep these anchors' }));
    expect(api.confirmStage).toHaveBeenCalledWith('letter', 'sections');
    expect(api.startStage).not.toHaveBeenCalled();
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('blocks Keep and Apply with a reason while the caller holds unsaved edits', async () => {
    const stale = {
      stage: 'sections' as const,
      state: 'stale' as const,
      status: 'Stale — Outputs changed',
      metrics: [],
    };
    const { api } = panel(
      { listProposals: vi.fn(async () => [changeProposalView({ stage: 'sections' })]) },
      {
        stage: 'sections',
        title: 'Sections',
        item: stale,
        blockedReason: 'Save your anchors first',
      },
    );
    const keep = await screen.findByRole('button', { name: 'Keep these anchors' });
    expect(keep).toBeDisabled();
    expect(keep).toHaveAttribute('title', 'Save your anchors first');
    const apply = screen.getByRole('button', { name: /^Apply \d+ selected change/ });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAttribute('title', 'Save your anchors first');
    expect(api.confirmStage).not.toHaveBeenCalled();
  });

  it('says why keeping failed', async () => {
    panel(
      {
        listProposals: vi.fn(async () => [changeProposalView({ status: 'accepted' })]),
        confirmStage: vi.fn(async () => {
          throw new ApiError('stage outputs is not stale', 409);
        }),
      },
      {
        title: 'Outputs',
        item: { stage: 'outputs', state: 'stale', status: 'Stale — Survey changed', metrics: [] },
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Keep these outputs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not stale');
  });

  it('names the steps stage Pipeline: Keep, Propose and the link after Sections', async () => {
    panel(
      {
        listProposals: vi.fn(async () => [
          changeProposalView({ stage: 'steps', status: 'accepted', acceptedChanges: [0, 1] }),
        ]),
      },
      {
        stage: 'steps',
        title: 'Extraction pipeline',
        item: { stage: 'steps', state: 'stale', status: 'Stale — Sections changed', metrics: [] },
      },
    );
    const banner = await screen.findByRole('note');
    expect(banner).toHaveTextContent('Check the pipeline below');
    expect(within(banner).getByRole('button', { name: 'Keep this pipeline' })).toBeInTheDocument();
  });

  it('proposes a pipeline before the first proposal', async () => {
    panel({ listProposals: vi.fn(async () => []) }, { stage: 'steps' });
    expect(await screen.findByRole('button', { name: 'Propose a pipeline' })).toBeInTheDocument();
  });

  it('points from Sections to the Pipeline tab once applied', async () => {
    const p = changeProposalView({
      stage: 'sections',
      status: 'accepted',
      acceptedChanges: [0, 1],
    });
    panel({ listProposals: vi.fn(async () => [p]) }, { stage: 'sections' });
    expect(await screen.findByRole('link', { name: 'Go to Pipeline' })).toHaveAttribute(
      'href',
      '#/workbench/letter/steps',
    );
  });
});
