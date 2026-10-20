import type { DraftLog } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { ModelLogButton } from '../src/workbench/DraftLogDialog.js';
import { fakeApi } from './fake-api.js';

const LOG: DraftLog = {
  stage: 'sections',
  model: 'local/qwen',
  tools: true,
  legacy: false,
  rounds: [
    {
      label: 'draft-sections',
      entries: [
        { kind: 'prompt', text: '<harness>the whole context</harness>', images: 0 },
        { kind: 'reply', text: '', inputTokens: 900, outputTokens: 40 },
        {
          kind: 'toolCall',
          id: 'c1',
          name: 'test_anchors',
          input: { changes: [{ op: 'putSection', id: 'totals', anchor: '^TOTALS' }] },
          summary: 'Testing 1 anchor on 2 dev samples',
        },
        {
          kind: 'toolResult',
          id: 'c1',
          name: 'test_anchors',
          text: 'Tested on 2 dev sample(s)…',
          isError: false,
        },
        { kind: 'reply', text: '', inputTokens: 950, outputTokens: 120 },
        {
          kind: 'toolCall',
          id: 'c2',
          name: 'submit',
          input: { notes: '' },
          summary: 'Submitting the answer',
        },
        { kind: 'rejected', errors: ["<root>: 'changes' is a required property"] },
        { kind: 'error', message: 'drafting model refused: no' },
      ],
    },
    {
      label: 'draft-sections-anchors',
      entries: [{ kind: 'prompt', text: 'again', images: 0 }],
    },
  ],
};

function open(getProposalLog = vi.fn(async () => LOG)) {
  const api = fakeApi({ getProposalLog });
  render(<ModelLogButton api={api} projectId="letter" proposalId="p1" />);
  return { api, getProposalLog };
}

describe('ModelLogButton', () => {
  it('opens the model log of a proposal: rounds and attempts on the left, one attempt on the right', async () => {
    const { getProposalLog } = open();
    await userEvent.click(screen.getByRole('button', { name: 'Model log' }));
    const dialog = await screen.findByRole('dialog', { name: 'Model log' });
    expect(getProposalLog).toHaveBeenCalledWith('letter', 'p1');
    expect(await within(dialog).findByText('2 replies · 1 tool call')).toBeInTheDocument();
    const nav = within(dialog).getByRole('navigation', { name: 'Rounds and attempts' });
    expect(within(nav).getByText('Proposal')).toBeInTheDocument();
    expect(within(nav).getByText('Anchor round')).toBeInTheDocument();
    const first = within(nav).getByRole('button', { name: 'Proposal, attempt 1 refused' });
    expect(first).toHaveAttribute('aria-pressed', 'true');
    // The first attempt: its tool calls, the answer, and the errors that sent it back.
    const shown = within(dialog).getByRole('region', { name: 'Proposal, attempt 1' });
    expect(within(shown).getByText('Errors that sent it back')).toBeInTheDocument();
    expect(within(shown).getByText("<root>: 'changes' is a required property")).toBeInTheDocument();
    expect(within(shown).getByText('Testing 1 anchor on 2 dev samples')).toBeInTheDocument();
    expect(within(shown).getByText('Answer submitted')).toBeInTheDocument();
    // The prompt is folded away until asked for.
    const prompt = within(shown).getByText(/Prompt sent/);
    expect(within(shown).getByText('<harness>the whole context</harness>')).not.toBeVisible();
    await userEvent.click(prompt);
    expect(within(shown).getByText('<harness>the whole context</harness>')).toBeVisible();
    // The next attempt was stopped by an error.
    await userEvent.click(within(nav).getByRole('button', { name: 'Proposal, attempt 2 stopped' }));
    const stopped = within(dialog).getByRole('region', { name: 'Proposal, attempt 2' });
    expect(within(stopped).getByText('drafting model refused: no')).toBeInTheDocument();
    expect(
      within(nav).getByRole('button', { name: 'Anchor round, attempt 1 no answer' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Help: Reading a model log' })).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says when a log is rebuilt from an older run', async () => {
    open(vi.fn(async () => ({ ...LOG, tools: false, legacy: true })));
    await userEvent.click(screen.getByRole('button', { name: 'Model log' }));
    expect(
      await screen.findByText(/from before the full model log: prompts, replies and rejections/),
    ).toBeInTheDocument();
  });

  it('says why there is no log', async () => {
    open(
      vi.fn(async () => {
        throw new ApiError('no model log for this run', 404);
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Model log' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no model log for this run');
  });
});
