import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF } from '@ih/shared';
import { SurveyTab } from '../src/workbench/SurveyTab.js';
import { fakeApi, proposalView } from './fake-api.js';

const brief = {
  projectId: 'letter',
  version: 2,
  body: { ...EMPTY_BRIEF, purpose: 'QA' },
  createdAt: '',
};

function tab(overrides = {}, dataPolicy: 'local' | 'external' = 'local') {
  const api = fakeApi(overrides);
  const onBriefSaved = vi.fn();
  render(
    <SurveyTab
      api={api}
      projectId="letter"
      dataPolicy={dataPolicy}
      brief={brief}
      onBriefSaved={onBriefSaved}
      pollMs={1}
    />,
  );
  return { api, onBriefSaved };
}

describe('SurveyTab', () => {
  it('runs a survey and polls until it is ready', async () => {
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([proposalView({ status: 'running', body: null })])
      .mockResolvedValue([proposalView()]);
    const { api } = tab({
      listProposals,
      startStage: vi.fn(async () => proposalView({ status: 'running', body: null })),
    });
    expect(await screen.findByText(/holdout samples are never sent/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run survey' }));
    expect(api.startStage).toHaveBeenCalledWith('letter', 'survey');
    expect(
      await screen.findByText('Process validation protocols, blank and executed.'),
    ).toBeInTheDocument();
    const candidates = screen.getByRole('table', { name: 'Candidate data' });
    expect(within(candidates).getByText('protocol_number')).toBeInTheDocument();
  });

  it('warns that external models may receive dev sample text', async () => {
    tab({}, 'external');
    expect(
      await screen.findByText(/may be sent to an external model provider/),
    ).toBeInTheDocument();
  });

  it('shows why a survey failed', async () => {
    tab({
      listProposals: vi.fn(async () => [
        proposalView({ status: 'failed', body: null, error: 'data policy: project is local-only' }),
      ]),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('data policy');
  });

  it('shows an error when polling fails instead of looping silently', async () => {
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce([proposalView({ status: 'running', body: null })])
      .mockRejectedValue(new Error('network down'));
    tab({ listProposals });
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  });

  it('clears a poll error once polling succeeds again', async () => {
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce([proposalView({ status: 'running', body: null })])
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue([proposalView({ status: 'running', body: null })]);
    tab({ listProposals });
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    await waitFor(() => expect(screen.queryByText('network down')).not.toBeInTheDocument());
  });

  it('keeps rows whose names or strings repeat', async () => {
    const base = proposalView();
    const body = base.body!;
    tab({
      listProposals: vi.fn(async () => [
        {
          ...base,
          body: {
            ...body,
            variants: ['Same', 'Same'],
            candidates: [body.candidates[0]!, body.candidates[0]!],
          },
        },
      ]),
    });
    expect(await screen.findAllByText('Same')).toHaveLength(2);
    const table = screen.getByRole('table', { name: 'Candidate data' });
    expect(within(table).getAllByText('protocol_number')).toHaveLength(2);
  });

  it('saves answers into the brief, keeping the rest of it', async () => {
    const saved = { ...brief, version: 3 };
    const { api, onBriefSaved } = tab({
      listProposals: vi.fn(async () => [proposalView()]),
      saveBrief: vi.fn(async () => saved),
    });
    await userEvent.type(
      await screen.findByLabelText('Which copy should be extracted?'),
      'The executed copy',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save answers to brief' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', {
      ...brief.body,
      answers: [{ question: 'Which copy should be extracted?', answer: 'The executed copy' }],
    });
    expect(onBriefSaved).toHaveBeenCalledWith(saved);
  });

  it('accepts a ready survey', async () => {
    const p = proposalView();
    const { api } = tab({
      listProposals: vi.fn(async () => [p]),
      decideProposal: vi.fn(async () => ({ ...p, status: 'accepted' as const })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', p.id, 'accepted');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull());
    expect(screen.getByText(/accepted/i)).toBeInTheDocument();
  });

  it('prefills a question the brief already answers', async () => {
    const answered = {
      ...brief,
      body: {
        ...brief.body,
        answers: [{ question: 'Which copy should be extracted?', answer: 'Blank' }],
      },
    };
    const api = fakeApi({ listProposals: vi.fn(async () => [proposalView()]) });
    render(
      <SurveyTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        brief={answered}
        onBriefSaved={vi.fn()}
        pollMs={1}
      />,
    );
    expect(await screen.findByLabelText('Which copy should be extracted?')).toHaveValue('Blank');
    expect(screen.getByRole('button', { name: 'Save answers to brief' })).toBeDisabled();
  });

  it('does not re-save answers to questions that are no longer shown', async () => {
    const second = proposalView({
      body: {
        ...proposalView().body!,
        questions: [{ question: 'Is page 1 a cover?', why: 'Layout' }],
      },
    });
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce([proposalView()])
      .mockResolvedValue([second]);
    const { api } = tab({
      listProposals,
      saveBrief: vi.fn(async () => ({ ...brief, version: 3 })),
      startStage: vi.fn(async () => second),
    });
    await userEvent.type(await screen.findByLabelText('Which copy should be extracted?'), 'Exec');
    await userEvent.click(screen.getByRole('button', { name: 'Save answers to brief' }));
    await userEvent.click(screen.getByRole('button', { name: 'Run survey again' }));
    const next = await screen.findByLabelText('Is page 1 a cover?');
    expect(screen.getByRole('button', { name: 'Save answers to brief' })).toBeDisabled();
    await userEvent.type(next, 'Yes');
    await userEvent.click(screen.getByRole('button', { name: 'Save answers to brief' }));
    expect(api.saveBrief).toHaveBeenLastCalledWith('letter', {
      ...brief.body,
      answers: [{ question: 'Is page 1 a cover?', answer: 'Yes' }],
    });
  });
});
