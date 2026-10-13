import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF, surveyBodyOf, type StageView, type SurveyBody } from '@ih/shared';
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
    const body = surveyBodyOf(base) as SurveyBody;
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
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 answer to brief (v3)' }));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Accept survey' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', p.id, 'accepted');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept survey' })).toBeNull());
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
    expect(screen.getByRole('button', { name: 'Save answers to brief (v3)' })).toBeDisabled();
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
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 answer to brief (v3)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Run again' }));
    const next = await screen.findByLabelText('Is page 1 a cover?');
    expect(screen.getByRole('button', { name: 'Save answers to brief (v3)' })).toBeDisabled();
    await userEvent.type(next, 'Yes');
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 answer to brief (v3)' }));
    expect(api.saveBrief).toHaveBeenLastCalledWith('letter', {
      ...brief.body,
      answers: [{ question: 'Is page 1 a cover?', answer: 'Yes' }],
    });
  });

  it('cannot skip while the survey is running', async () => {
    tab({ listProposals: vi.fn(async () => [proposalView({ status: 'running', body: null })]) });
    expect(await screen.findByRole('button', { name: 'Skip this stage' })).toBeDisabled();
  });

  it('skips the survey and reports the change', async () => {
    const onChanged = vi.fn();
    const api = fakeApi({ skipStage: vi.fn(async () => []) });
    render(
      <SurveyTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        brief={brief}
        onBriefSaved={vi.fn()}
        pollMs={1}
        onChanged={onChanged}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Skip this stage' }));
    expect(api.skipStage).toHaveBeenCalledWith('letter', 'survey');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('numbers the questions and counts answers, saved or typed', async () => {
    const answered = {
      ...brief,
      body: {
        ...brief.body,
        answers: [{ question: 'Which copy should be extracted?', answer: 'Executed' }],
      },
    };
    const body = proposalView().body as SurveyBody;
    const api = fakeApi({
      listProposals: vi.fn(async () => [
        proposalView({
          body: {
            ...body,
            questions: [...body.questions, { question: 'Credit notes?', why: 'Layout' }],
          },
        }),
      ]),
    });
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
    const card = (await screen.findByRole('heading', { name: 'Questions from the model' })).closest(
      'section',
    )!;
    expect(within(card).getByText('1 of 2 answered')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: /Answered 1 of 2/ })).toBeInTheDocument();
    expect(within(card).getByText('Why it asks: Some PDFs hold two copies')).toBeInTheDocument();
    await userEvent.type(within(card).getByLabelText('Credit notes?'), 'Reject them');
    expect(within(card).getByText('2 of 2 answered')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Save 1 answer to brief (v3)' })).toBeEnabled();
  });

  it('shows what the model found, the candidates with In brief and samples seen, and the anatomy', async () => {
    const body = proposalView().body as SurveyBody;
    tab({
      listProposals: vi.fn(async () => [
        proposalView({
          body: {
            ...body,
            variants: ['Acme — two-column header'],
            candidates: [
              { ...body.candidates[0]!, seenIn: { n: 3, of: 6 } },
              { name: 'batch_size', description: 'Batch size', where: 'table', kind: 'table' },
            ],
          },
        }),
      ]),
    });
    const found = (await screen.findByRole('heading', { name: 'What the model found' })).closest(
      'section',
    )!;
    expect(within(found).getByText(/local\/qwen · brief v1/)).toBeInTheDocument();
    expect(within(found).getByText('Acme — two-column header')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Candidate data' });
    const [, first, second] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('FIELD');
    expect(first).toHaveTextContent('page header — 3 of 6 samples');
    expect(first).toHaveTextContent('Not yet'); // the brief's purpose is not its outputs
    expect(second).toHaveTextContent('TABLE');
    expect(
      screen.getByText('1 field · 1 table · the Outputs stage turns these into fields and tables'),
    ).toBeInTheDocument();
    const anatomy = screen.getByRole('complementary', { name: 'Document anatomy' });
    expect(within(anatomy).getByText('Find it: PROTOCOL APPROVAL')).toBeInTheDocument();
  });

  it('says In brief once the brief asks for a candidate', async () => {
    const api = fakeApi({ listProposals: vi.fn(async () => [proposalView()]) });
    render(
      <SurveyTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        brief={{ ...brief, body: { ...brief.body, outputs: 'The protocol number' } }}
        onBriefSaved={vi.fn()}
        pollMs={1}
      />,
    );
    const table = await screen.findByRole('table', { name: 'Candidate data' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Yes');
  });

  it('warns that accepting replaces an earlier skip and names the stages that go stale', async () => {
    const at = '2026-10-03T09:00:00.000Z';
    const stage = (o: Partial<StageView> & Pick<StageView, 'stage'>): StageView => ({
      state: 'pending',
      completedAt: null,
      skippedAt: null,
      ...o,
    });
    tab({
      listProposals: vi.fn(async () => [proposalView()]),
      listStages: vi.fn(async () => [
        stage({ stage: 'survey', state: 'proposed', completedAt: at, skippedAt: at }),
        stage({ stage: 'outputs', state: 'accepted', completedAt: '2026-10-05T09:00:00.000Z' }),
        stage({ stage: 'sections', state: 'accepted', completedAt: '2026-10-06T09:00:00.000Z' }),
        stage({ stage: 'steps' }),
      ]),
    });
    const note = await screen.findByRole('note');
    expect(note).toHaveAttribute('data-tone', 'skip');
    expect(note).toHaveTextContent(
      /You skipped this stage on .+Accepting replaces the skip — Outputs and Sections were completed without it/,
    );
  });

  it('puts Run again and Skip in the tab header with the status', async () => {
    const api = fakeApi({ listProposals: vi.fn(async () => [proposalView()]) });
    render(
      <SurveyTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        brief={brief}
        onBriefSaved={vi.fn()}
        pollMs={1}
        item={{
          stage: 'survey',
          state: 'proposed',
          status: 'Survey ready — waiting for your decision',
          metrics: [],
        }}
      />,
    );
    const header = (await screen.findByRole('heading', { level: 2, name: 'Survey' })).closest(
      'header',
    )!;
    expect(
      within(header).getByText('Survey ready — waiting for your decision'),
    ).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Run again' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Skip this stage' })).toBeInTheDocument();
  });

  it('points to Outputs once accepted', async () => {
    const p = proposalView();
    tab({
      listProposals: vi.fn(async () => [p]),
      decideProposal: vi.fn(async () => ({ ...p, status: 'accepted' as const })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept survey' }));
    expect(await screen.findByRole('link', { name: 'Go to Outputs' })).toHaveAttribute(
      'href',
      '#/workbench/letter/outputs',
    );
  });
});
