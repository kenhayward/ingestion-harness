import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { changeBodyOf, type ProposalView } from '@ih/shared';
import { ProposalCard } from '../src/workbench/ProposalCard.js';
import { changeProposalView } from './fake-api.js';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const NEXT = {
  href: '#/workbench/letter/sections',
  label: 'Go to Sections',
  text: 'Next, check where each section starts in the dev samples.',
};

function card(p: ProposalView, props: Partial<Parameters<typeof ProposalCard>[0]> = {}) {
  const handlers = { onToggle: vi.fn(), onApply: vi.fn(), onReject: vi.fn() };
  render(
    <ProposalCard
      projectId="letter"
      proposal={p}
      body={changeBodyOf(p)!}
      definition={null}
      draftVersion={4}
      selected={new Set([0, 1])}
      busy={false}
      now={NOW}
      next={NEXT}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('ProposalCard', () => {
  it('offers to accept a proposal that needs no changes', async () => {
    const p = changeProposalView({
      stage: 'sections',
      body: { notes: 'The anchors still fit every sample.', changes: [] },
    });
    const h = card(p, { selected: new Set() });
    expect(
      screen.getByRole('heading', { level: 3, name: 'Proposal · no changes needed' }),
    ).toBeInTheDocument();
    expect(screen.getByText('The anchors still fit every sample.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const accept = screen.getByRole('button', { name: 'Accept: no changes needed' });
    expect(accept).toBeEnabled();
    await userEvent.click(accept);
    expect(h.onApply).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reject all' })).toBeInTheDocument();
  });

  it('says a proposal was accepted with no changes', () => {
    card(
      changeProposalView({
        status: 'accepted',
        body: { notes: '', changes: [] },
        acceptedChanges: [],
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Accepted: no changes needed');
  });

  it('lists every change with a tick box, a live count, Apply and Reject all', async () => {
    const h = card(changeProposalView());
    expect(
      screen.getByRole('heading', { level: 3, name: 'Proposal · 2 of 2 changes selected' }),
    ).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: 'Apply: FIELD protocol_number text' });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(h.onToggle).toHaveBeenCalledWith(0);
    await userEvent.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    expect(h.onApply).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    expect(h.onReject).toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Proposal' }).style.borderColor).toBe(
      'var(--ih-warn-fg)',
    );
  });

  it('tags a removal with the danger tone, as the Outputs table does', () => {
    const p = changeProposalView({
      body: {
        notes: '',
        changes: [{ op: 'removeOutput', reason: 'Unused', id: 'old' }],
      },
    });
    card(p, {
      definition: { outputs: { fields: [{ id: 'old' }], tables: [] } },
      selected: new Set([0]),
    });
    expect(screen.getByText('REMOVED')).toHaveClass('tone-danger');
    expect(screen.getByText('REMOVE')).toHaveClass('tone-danger');
  });

  it('cannot apply nothing', () => {
    card(changeProposalView(), { selected: new Set() });
    expect(screen.getByRole('button', { name: 'Apply 0 selected changes' })).toBeDisabled();
  });

  it('tags new and changed outputs against the draft, with the diff chip', () => {
    card(changeProposalView(), {
      definition: { outputs: { fields: [{ id: 'approved_on', type: 'text' }], tables: [] } },
    });
    const added = screen
      .getByRole('checkbox', { name: 'Apply: FIELD protocol_number text' })
      .closest('li')!;
    expect(within(added).getByText('NEW')).toBeInTheDocument();
    expect(within(added).getByText('+ protocol_number')).toBeInTheDocument();
    const changed = screen
      .getByRole('checkbox', { name: 'Apply: FIELD approved_on date' })
      .closest('li')!;
    expect(within(changed).getByText('CHANGED')).toBeInTheDocument();
    expect(within(changed).getByText('type text → date')).toBeInTheDocument();
  });

  it('has no NEW/CHANGED tags without the draft', () => {
    card(changeProposalView());
    expect(screen.queryByText('NEW')).toBeNull();
    expect(screen.queryByText('CHANGED')).toBeNull();
  });

  it('becomes the applied card with the next action and the latest proposal', () => {
    card(changeProposalView({ status: 'partially_accepted', acceptedChanges: [1] }));
    const region = screen.getByRole('region', { name: 'Proposal' });
    expect(region.style.borderColor).toBe('var(--ih-ok-fg)');
    expect(
      within(region).getByRole('heading', { level: 3, name: '1 of 2 changes applied to draft v4' }),
    ).toBeInTheDocument();
    expect(within(region).getByText(NEXT.text)).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Go to Sections' })).toHaveAttribute(
      'href',
      NEXT.href,
    );
    expect(within(region).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(region).queryByRole('button', { name: 'Reject all' })).toBeNull();
    expect(within(region).getByText('Latest proposal')).toBeInTheDocument();
    // Inside a closed <details>: query by text, not by role.
    expect(within(region).getByText('Not applied').closest('li')).toHaveTextContent(
      'protocol_number',
    );
    expect(within(region).getByText('Applied').closest('li')).toHaveTextContent('approved_on');
  });

  it('announces the applied count as a status', () => {
    card(changeProposalView({ status: 'accepted', acceptedChanges: [0, 1] }));
    expect(screen.getByRole('status')).toHaveTextContent('2 of 2 changes applied to draft v4');
  });

  it('leaves a failed proposal to the panel alert', () => {
    card(changeProposalView({ status: 'failed', error: 'model down' }));
    expect(screen.queryByRole('heading', { name: /failed/ })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says a rejected proposal was rejected, without a next action', () => {
    card(changeProposalView({ status: 'rejected' }));
    expect(
      screen.getByRole('heading', { level: 3, name: 'Proposal rejected' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to Sections' })).toBeNull();
    expect(screen.getAllByText('Not applied')).toHaveLength(2);
  });

  it('draws a badge beside each change and a footer note', () => {
    card(changeProposalView(), {
      badge: (_c, i) => (i === 0 ? <span>Answers 1</span> : null),
      footerNote: 'Feedback a change answers is marked answered when you apply it.',
    });
    const [first, second] = within(screen.getByRole('region', { name: 'Proposal' })).getAllByRole(
      'listitem',
    );
    if (!first || !second) throw new Error('expected two changes');
    expect(first).toHaveTextContent('Answers 1');
    expect(within(first).getByText('Answers 1').parentElement).toHaveClass('proposal-badge');
    expect(second.querySelector('.proposal-badge')).toBeNull();
    expect(second).not.toHaveTextContent('Answers');
    expect(
      screen.getByText('Feedback a change answers is marked answered when you apply it.'),
    ).toBeInTheDocument();
  });
});
