import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FeedbackItem, ProposalView } from '@ih/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import { ReviseTab } from '../src/workbench/ReviseTab.js';
import {
  changeProposalView,
  fakeApi,
  feedbackItem,
  revisePreview,
  reviseProposal,
} from './fake-api.js';

const sentOf = (f: FeedbackItem) => ({
  id: f.id,
  target: f.target,
  targetId: f.targetId,
  sample: null,
  body: f.body,
});

function tab(overrides: Partial<Api> = {}, props: { draft?: number | null; pollMs?: number } = {}) {
  const api = fakeApi(overrides);
  const onApplied = vi.fn();
  const onChanged = vi.fn();
  render(
    <ReviseTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      draft={props.draft === undefined ? 4 : props.draft}
      pollMs={props.pollMs ?? 60_000}
      onApplied={onApplied}
      onChanged={onChanged}
      now={Date.parse('2026-10-13T12:00:00.000Z')}
    />,
  );
  return { api, onApplied, onChanged };
}

const failing = {
  failures: [
    {
      sample: 'inv-0039-hooli.pdf',
      score: 0.84,
      fields: [{ id: 'due_date', expected: '2026-10-03', actual: null }],
      tables: [],
    },
    {
      sample: 'inv-0012-initech.pdf',
      score: 0.85,
      fields: [{ id: 'total', expected: '4,694.40', actual: '3,912.00' }],
      tables: [],
    },
  ],
  failuresTotal: 2,
  failuresFrom: {
    iterationId: crypto.randomUUID(),
    templateVersion: 4,
    model: null,
    createdAt: '2026-10-12T09:02:00.000Z',
    compared: 6,
  },
  notSent: {
    holdoutSamples: 2,
    holdoutRun: { iterationId: crypto.randomUUID(), status: 'complete' as const, score: 0.88 },
  },
};

describe('ReviseTab', () => {
  it('shows what the model will see and asks for a revision', async () => {
    const { api } = tab({
      getRevisePreview: vi.fn(async () => revisePreview(failing)),
      listFeedback: vi.fn(async () => [feedbackItem({ targetId: 'total' })]),
      startStage: vi.fn(async () => reviseProposal({ status: 'running', body: null })),
    });
    const card = await screen.findByRole('region', { name: 'What the model will see' });
    expect(card).toHaveTextContent(
      '1 feedback item · 2 failure diffs (up to 20 fields and 5 rows per table each) · draft v4 · Main Production Model',
    );
    const failures = within(card).getByRole('region', {
      name: /Failures from the latest dev run/,
    });
    const rows = within(failures).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('inv-0039-hooli.pdf');
    expect(rows[0]).toHaveTextContent('84%');
    expect(rows[1]).toHaveTextContent('total 3,912.00 ≠ 4,694.40');
    expect(
      within(failures).getByText('Not sent: the holdout run (88%) and its 2 samples.'),
    ).toHaveClass('holdout-note');
    await userEvent.click(
      within(card).getByRole('button', { name: 'Ask the model for a revision' }),
    );
    expect(api.startStage).toHaveBeenCalledWith('letter', 'revise');
  });

  it.each([
    [
      { getRevisePreview: vi.fn(async () => revisePreview({ feedback: [] })) },
      4,
      'Add feedback first: a revision answers your feedback',
    ],
    [
      { getRevisePreview: vi.fn(async () => revisePreview({ draft: null })) },
      null,
      'Start the next version on the Recipe tab first',
    ],
    [
      { listProposals: vi.fn(async () => [reviseProposal({ status: 'running', body: null })]) },
      4,
      'A revision is being drafted',
    ],
  ])('says why it cannot ask (%#)', async (overrides, draft, reason) => {
    tab(overrides, { draft });
    const ask = await screen.findByRole('button', { name: 'Ask the model for a revision' });
    expect(ask).toBeDisabled();
    expect(ask).toHaveAttribute('title', reason);
  });

  it('says when no dev run has failures to send', async () => {
    tab();
    expect(
      await screen.findByText('No complete dev run yet. Evaluate on dev to send its failures.'),
    ).toBeInTheDocument();
  });

  it('warns when another stage has a proposal waiting, with a link to decide it', async () => {
    tab({ listProposals: vi.fn(async () => [changeProposalView({ stage: 'steps' })]) });
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Steps has an open proposal.');
    expect(within(note).getByRole('link', { name: 'Open Steps' })).toHaveAttribute(
      'href',
      '#/workbench/letter/steps',
    );
  });

  it('shows a running strip while the revision is drafted, then polls until it is ready', async () => {
    const ready = reviseProposal();
    tab(
      {
        listProposals: vi
          .fn()
          .mockResolvedValueOnce([{ ...ready, status: 'running', body: null }])
          .mockResolvedValue([ready]),
      },
      { pollMs: 1 },
    );
    expect(await screen.findByRole('region', { name: 'Proposal' })).toBeInTheDocument();
  });

  it('shows the running strip', async () => {
    tab({ listProposals: vi.fn(async () => [reviseProposal({ status: 'running', body: null })]) });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'The model is drafting a revision…',
    );
  });

  it('badges each change with the feedback it answers, then marks it ANSWERED after Apply', async () => {
    const one = feedbackItem({ targetId: 'total', body: 'Take TOTAL DUE' });
    const two = feedbackItem({ target: 'step', targetId: 'head', body: 'Say what these are' });
    const ready = reviseProposal({
      body: {
        notes: '',
        changes: [
          {
            op: 'putField',
            field: { id: 'total', type: 'decimal' },
            reason: 'feedback 1',
            answers: [one.id],
          },
          {
            op: 'setPreamble',
            preamble: 'Supplier invoices.',
            reason: 'feedback 2',
            answers: [two.id],
          },
        ],
      },
    });
    const accepted = { ...ready, status: 'accepted' as const, acceptedChanges: [0, 1] };
    const { api, onApplied } = tab({
      getRevisePreview: vi.fn(async () => revisePreview({ feedback: [sentOf(one), sentOf(two)] })),
      listFeedback: vi
        .fn()
        .mockResolvedValueOnce([one, two])
        .mockResolvedValue([
          { ...one, resolvedBy: ready.id },
          { ...two, resolvedBy: ready.id },
        ]),
      listProposals: vi.fn().mockResolvedValueOnce([ready]).mockResolvedValue([accepted]),
      decideProposal: vi.fn(async () => accepted),
    });
    const proposal = await screen.findByRole('region', { name: 'Proposal' });
    const [first, second] = within(proposal).getAllByRole('listitem');
    expect(first).toHaveTextContent('Answers 1');
    expect(second).toHaveTextContent('Answers 2');
    expect(
      within(proposal).getByText('Feedback a change answers is marked answered when you apply it.'),
    ).toBeInTheDocument();
    await userEvent.click(
      within(proposal).getByRole('button', { name: 'Apply 2 selected changes' }),
    );
    expect(api.decideProposal).toHaveBeenCalledWith('letter', ready.id, 'accepted', [0, 1]);
    await waitFor(() => expect(screen.getAllByText('ANSWERED')).toHaveLength(2));
    expect(onApplied).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Evaluate on dev' })).toHaveAttribute(
      'href',
      '#/workbench/letter/evaluate',
    );
  });

  it('lists earlier revisions, collapsed', async () => {
    const older = reviseProposal({
      status: 'accepted',
      acceptedChanges: [0, 1],
      createdAt: '2026-10-10T08:00:00.000Z',
    });
    tab({
      listProposals: vi.fn(async () => [reviseProposal(), older]),
      listFeedback: vi.fn(async () => [feedbackItem({ resolvedBy: older.id })]),
    });
    const details = (await screen.findByText('Earlier revisions · 1')).closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('2 of 2 applied · answered 1 feedback item');
  });

  it('shows why it could not load, and loads again on Retry', async () => {
    const { api } = tab({
      getRevisePreview: vi
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValue(revisePreview()),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('down');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('region', { name: 'What the model will see' }),
    ).toBeInTheDocument();
    expect(api.getRevisePreview).toHaveBeenCalledTimes(2);
  });

  it('numbers only the feedback the model is sent and lists the rest as not sent', async () => {
    const sent = feedbackItem({ targetId: 'total', body: 'goes to the model' });
    const held = feedbackItem({ targetId: 'sender', body: 'its sample went to holdout' });
    tab({
      getRevisePreview: vi.fn(async () => revisePreview({ feedback: [sentOf(sent)] })),
      listFeedback: vi.fn(async () => [held, sent]),
    });
    const list = await screen.findByRole('region', { name: /Your feedback/ });
    expect(within(list).getByRole('heading', { name: 'Your feedback 1 open' })).toBeInTheDocument();
    const [first] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('goes to the model');
    expect(first).not.toHaveTextContent('its sample went to holdout');
    expect(
      within(within(list).getByRole('region', { name: 'Not sent' })).getByText(
        'its sample went to holdout',
      ),
    ).toBeInTheDocument();
  });

  it('tells the page after feedback changes, after Ask and after Reject', async () => {
    const ready = reviseProposal();
    const { api, onChanged } = tab({
      listFeedback: vi.fn(async () => []),
      listProposals: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValue([ready]),
      addFeedback: vi.fn(async () => feedbackItem()),
      startStage: vi.fn(async () => reviseProposal({ status: 'running', body: null })),
      decideProposal: vi.fn(async () => ({ ...ready, status: 'rejected' as const })),
    });
    await screen.findByRole('region', { name: 'What the model will see' });
    expect(onChanged).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Feedback' }), 'Use the letterhead');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.addFeedback).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Ask the model for a revision' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    await userEvent.click(await screen.findByRole('button', { name: 'Reject all' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
  });

  it('tells the page when a running revision becomes ready', async () => {
    const ready = reviseProposal();
    const { onChanged } = tab(
      {
        listProposals: vi
          .fn()
          .mockResolvedValueOnce([{ ...ready, status: 'running', body: null }])
          .mockResolvedValue([ready]),
      },
      { pollMs: 1 },
    );
    await screen.findByRole('region', { name: 'Proposal' });
    // The page is told from an effect, which runs just after the render that shows the card:
    // wait for it rather than assume it ran before the card appeared (flaky on slow CI).
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('surfaces a failure to start the revision', async () => {
    tab({
      startStage: vi.fn(async () => Promise.reject(new Error('no drafting model'))),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Ask the model for a revision' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('no drafting model');
  });

  it('does not ask when the drafting model is not set', async () => {
    tab({ getRevisePreview: vi.fn(async () => revisePreview({ model: null })) });
    const ask = await screen.findByRole('button', { name: 'Ask the model for a revision' });
    expect(ask).toBeDisabled();
    expect(ask).toHaveAttribute('title', 'Set the drafting model on the Models page first');
  });

  it('says how many failing dev samples are left out, and when every sample scored 100%', async () => {
    tab({
      getRevisePreview: vi.fn(async () =>
        revisePreview({ ...failing, failuresTotal: 11, failures: failing.failures }),
      ),
    });
    expect(
      await screen.findByText(/9 more failing dev samples are not sent \(the worst 8 are\)/),
    ).toBeInTheDocument();
  });

  it('says every dev sample scored 100% when nothing fails', async () => {
    tab({
      getRevisePreview: vi.fn(async () =>
        revisePreview({ failuresFrom: failing.failuresFrom, failures: [], failuresTotal: 0 }),
      ),
    });
    expect(await screen.findByText('Every dev sample scored 100%.')).toBeInTheDocument();
  });

  it('does not stack polls while a load is slow, and keeps the slow response', async () => {
    const ready = reviseProposal();
    let release: (v: ProposalView[]) => void = () => undefined;
    const slow = new Promise<ProposalView[]>((resolve) => {
      release = resolve;
    });
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce([{ ...ready, status: 'running', body: null }])
      .mockReturnValueOnce(slow)
      .mockResolvedValue([ready]);
    tab({ listProposals }, { pollMs: 5 });
    await screen.findByRole('status');
    await new Promise((r) => setTimeout(r, 60));
    expect(listProposals).toHaveBeenCalledTimes(2); // the tick found a load pending and waited
    release([ready]);
    expect(await screen.findByRole('region', { name: 'Proposal' })).toBeInTheDocument();
  });

  it('stops polling once the revision is ready', async () => {
    const ready = reviseProposal();
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce([{ ...ready, status: 'running', body: null }])
      .mockResolvedValue([ready]);
    tab({ listProposals }, { pollMs: 5 });
    await screen.findByRole('region', { name: 'Proposal' });
    const calls = listProposals.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(listProposals.mock.calls.length).toBe(calls);
  });
});
