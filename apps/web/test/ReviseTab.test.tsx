import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function tab(overrides: Partial<Api> = {}, props: { draft?: number | null; pollMs?: number } = {}) {
  const api = fakeApi(overrides);
  const onApplied = vi.fn();
  render(
    <ReviseTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      draft={props.draft === undefined ? 4 : props.draft}
      pollMs={props.pollMs ?? 60_000}
      onApplied={onApplied}
      now={Date.parse('2026-10-13T12:00:00.000Z')}
    />,
  );
  return { api, onApplied };
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
      '1 feedback item · 2 failure diffs (up to 20 fields and 5 rows per table each) · draft v4 · local/qwen',
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
      'Start the next version on the Template tab first',
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

  it('shows why it could not load', async () => {
    tab({ getRevisePreview: vi.fn(async () => Promise.reject(new Error('down'))) });
    expect(await screen.findByRole('alert')).toHaveTextContent('down');
  });
});
