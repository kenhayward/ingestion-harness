import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { StagePanel } from '../src/workbench/StagePanel.js';
import { changeProposalView, fakeApi, sampleView } from './fake-api.js';

function panel(overrides = {}, props: Partial<Parameters<typeof StagePanel>[0]> = {}) {
  const api = fakeApi(overrides);
  const onApplied = vi.fn();
  const onSkipped = vi.fn();
  render(
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
  return { api, onApplied, onSkipped };
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
    const first = await screen.findByRole('checkbox', { name: /Field protocol_number/ });
    expect(first).toBeChecked();
    await userEvent.click(first);
    await userEvent.click(screen.getByRole('button', { name: 'Apply selected changes' }));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Apply selected changes' }));
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
    const apply = await screen.findByRole('button', { name: 'Apply selected changes' });
    await userEvent.click(apply);
    expect(apply).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip this stage' })).toBeDisabled();
    await userEvent.click(apply);
    expect(decideProposal).toHaveBeenCalledTimes(1);
    release({ ...p, status: 'accepted' as const });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reject all' })).toBeNull());
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
    expect(await screen.findByRole('button', { name: 'Apply selected changes' })).toBeEnabled();
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
    const item = (await screen.findByRole('checkbox', { name: /Section approval/ })).closest('li')!;
    expect(
      await within(item).findByText('found in 1 of 2 dev samples (missed: b.pdf)'),
    ).toBeInTheDocument();
  });
});
