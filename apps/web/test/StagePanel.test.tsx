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
      name: 'Apply: Field protocol_number (text)',
    });
    expect(first).toBeChecked();
    expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeEnabled();
    await userEvent.click(first);
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', p.id, 'accepted', [1]);
    expect(onApplied).toHaveBeenCalled();
    expect(await screen.findByText(/1 of 2 changes applied/)).toBeInTheDocument();
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
    expect(
      screen.getByText('Start the next version on the Template tab first.'),
    ).toBeInTheDocument();
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
      { stage: 'steps', title: 'Extraction steps' },
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(screen.getByRole('heading', { level: 2, name: 'Extraction steps' })).toBeInTheDocument();
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
      await screen.findByRole('checkbox', { name: /^Apply: Section approval/ })
    ).closest('li')!;
    expect(
      await within(item).findByText('found in 1 of 2 dev samples (missed: b.pdf)'),
    ).toBeInTheDocument();
  });

  it('cannot apply when no change is selected', async () => {
    panel({ listProposals: vi.fn(async () => [changeProposalView()]) });
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Apply: Field protocol_number (text)' }),
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Apply: Field approved_on (date)' }),
    );
    expect(screen.getByRole('button', { name: 'Apply 0 selected changes' })).toBeDisabled();
  });

  it('puts the title, the status and the actions in the tab header', async () => {
    panel(
      { listProposals: vi.fn(async () => [changeProposalView({ stage: 'steps' })]) },
      {
        stage: 'steps',
        title: 'Extraction steps',
        item: { stage: 'steps', state: 'proposed', status: 'Needs your decision', metrics: [] },
      },
    );
    await screen.findByRole('button', { name: 'Propose again' });
    const header = screen
      .getByRole('heading', { level: 2, name: 'Extraction steps' })
      .closest('header')!;
    expect(header).not.toBeNull();
    expect(
      within(header).getByRole('heading', { level: 2, name: 'Extraction steps' }),
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

  it('shows a decided proposal read-only, bordered in its tone', async () => {
    const p = changeProposalView({ status: 'partially_accepted', acceptedChanges: [0] });
    panel({ listProposals: vi.fn(async () => [p]) });
    const first = await screen.findByRole('checkbox', {
      name: 'Apply: Field protocol_number (text)',
    });
    const second = screen.getByRole('checkbox', { name: 'Apply: Field approved_on (date)' });
    expect(first).toBeDisabled();
    expect(first).toBeChecked();
    expect(second).toBeDisabled();
    expect(second).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Reject all' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Proposal' }).style.borderColor).toBe(
      'var(--ih-ok-fg)',
    );
  });

  it('links to the Template tab for edits by hand', async () => {
    panel({ listProposals: vi.fn(async () => [changeProposalView()]) });
    expect(
      await screen.findByRole('link', { name: 'Edit by hand on the Template tab' }),
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
      await screen.findByRole('checkbox', { name: /^Apply: Extract step header/ })
    ).closest('li')!;
    expect(within(extract).getByText('EXTRACT')).toBeInTheDocument();
    expect(within(extract).getByText('header block')).toBeInTheDocument();
    const check = screen
      .getByRole('checkbox', { name: /^Apply: Check step totals/ })
      .closest('li')!;
    expect(within(check).getByText('CHECK')).toBeInTheDocument();
    expect(within(check).getByText('items.amount against total')).toBeInTheDocument();
  });
});
