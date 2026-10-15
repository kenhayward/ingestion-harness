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

/** Opens one of the Survey tab's own tabs (Findings, Questions, Candidates, Ontologies). */
async function open(name: string) {
  await userEvent.click(await screen.findByRole('tab', { name: new RegExp(`^${name}`) }));
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
    await open('Candidates');
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
    await open('Candidates');
    const table = screen.getByRole('table', { name: 'Candidate data' });
    expect(within(table).getAllByText('protocol_number')).toHaveLength(2);
  });

  it('saves answers into the brief, keeping the rest of it', async () => {
    const saved = { ...brief, version: 3 };
    const { api, onBriefSaved } = tab({
      listProposals: vi.fn(async () => [proposalView()]),
      saveBrief: vi.fn(async () => saved),
    });
    await open('Questions');
    await userEvent.type(
      screen.getByLabelText('Which copy should be extracted?'),
      'The executed copy',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 answer to brief (v3)' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', {
      ...brief.body,
      answers: [{ question: 'Which copy should be extracted?', answer: 'The executed copy' }],
    });
    expect(onBriefSaved).toHaveBeenCalledWith(saved);
  });

  it('explains why Save answers and Run again are disabled', async () => {
    tab({ listProposals: vi.fn(async () => [proposalView()]) });
    await open('Questions');
    const save = screen.getByRole('button', { name: 'Save answers to brief (v3)' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'Type an answer first');
    expect(screen.getByRole('button', { name: 'Run again' })).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Which copy should be extracted?'), 'Executed');
    const again = screen.getByRole('button', { name: 'Run again' });
    expect(again).toBeDisabled();
    expect(again).toHaveAttribute('title', 'Save your answers first');
    expect(screen.getByRole('button', { name: 'Save 1 answer to brief (v3)' })).not.toHaveAttribute(
      'title',
    );
  });

  it('clears a saved answer by saving it blank', async () => {
    const answered = {
      ...brief,
      body: {
        ...brief.body,
        answers: [{ question: 'Which copy should be extracted?', answer: 'Executed' }],
      },
    };
    const api = fakeApi({
      listProposals: vi.fn(async () => [proposalView()]),
      saveBrief: vi.fn(async () => ({ ...answered, version: 3 })),
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
    await open('Questions');
    await userEvent.clear(screen.getByLabelText('Which copy should be extracted?'));
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 answer to brief (v3)' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', { ...answered.body, answers: [] });
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
    await open('Questions');
    expect(screen.getByLabelText('Which copy should be extracted?')).toHaveValue('Blank');
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
    await open('Questions');
    await userEvent.type(screen.getByLabelText('Which copy should be extracted?'), 'Exec');
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
    await open('Questions');
    const card = screen
      .getByRole('heading', { name: 'Questions from the model' })
      .closest('section')!;
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
    expect(within(found).getByText(/Main Production Model · brief v1/)).toBeInTheDocument();
    expect(within(found).getByText('Acme — two-column header')).toBeInTheDocument();
    const anatomy = screen.getByRole('complementary', { name: 'Document anatomy' });
    expect(within(anatomy).getByText('Find it: PROTOCOL APPROVAL')).toBeInTheDocument();
    await open('Candidates');
    const table = screen.getByRole('table', { name: 'Candidate data' });
    const [, first, second] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('FIELD');
    expect(first).toHaveTextContent('page header — 3 of 6 samples');
    expect(first).toHaveTextContent('Not yet'); // the brief's purpose is not its outputs
    expect(second).toHaveTextContent('TABLE');
    expect(
      screen.getByText('1 field · 1 table · the Outputs stage turns these into fields and tables'),
    ).toBeInTheDocument();
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
    await open('Candidates');
    const table = screen.getByRole('table', { name: 'Candidate data' });
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

  it('splits the survey into Findings, Questions, Candidates and Ontologies, Findings first', async () => {
    tab({ listProposals: vi.fn(async () => [proposalView()]) });
    const list = await screen.findByRole('tablist', { name: 'Survey' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Findings',
      'Questions0/1',
      'Candidates1',
      'Ontologies',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'What the model found' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Document anatomy' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Questions from the model' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Candidate data' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Ontologies' })).toBeNull();

    await open('Candidates');
    expect(screen.getByRole('tab', { name: /^Candidates/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tabpanel', { name: /^Candidates/ })).toContainElement(
      screen.getByRole('table', { name: 'Candidate data' }),
    );
    expect(screen.queryByRole('heading', { name: 'What the model found' })).toBeNull();
    // Accept stays below the tabs, whichever is open.
    expect(screen.getByRole('button', { name: 'Accept survey' })).toBeInTheDocument();
  });

  it('keeps typed answers while another tab is open', async () => {
    tab({ listProposals: vi.fn(async () => [proposalView()]) });
    await open('Questions');
    await userEvent.type(screen.getByLabelText('Which copy should be extracted?'), 'Executed');
    expect(screen.getByRole('tab', { name: /^Questions/ })).toHaveTextContent('Questions1/1');
    await open('Ontologies');
    await open('Questions');
    expect(screen.getByLabelText('Which copy should be extracted?')).toHaveValue('Executed');
  });

  it('opens on the tab a link names', async () => {
    const api = fakeApi({ listProposals: vi.fn(async () => [proposalView()]) });
    render(
      <SurveyTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        brief={brief}
        onBriefSaved={vi.fn()}
        pollMs={1}
        view="ontologies"
      />,
    );
    expect(await screen.findByRole('tab', { name: 'Ontologies' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Ontologies' })).toBeInTheDocument();
  });

  it('says what each tab will hold before the survey has run', async () => {
    tab({ listProposals: vi.fn(async () => []) });
    expect(
      await screen.findByText('Run the survey to see what the model finds in the dev samples.'),
    ).toBeInTheDocument();
    await open('Questions');
    expect(
      screen.getByText('Run the survey to see the questions the model asks about the brief.'),
    ).toBeInTheDocument();
    await open('Candidates');
    expect(
      screen.getByText('Run the survey to see the data the model proposes to extract.'),
    ).toBeInTheDocument();
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

describe('SurveyTab ontology suggestions (final review fixes)', () => {
  const suggestions = {
    record: {
      surveyProposalId: 'p1',
      createdAt: '2026-10-15T10:00:00Z',
      candidates: 1,
      libraryKey: 'lexical|idmp@2',
      suggestions: [
        { ontologyId: 'idmp', version: 2, label: 'IDMP-O', covers: ['a', 'b'], evidence: [] },
      ],
      pinned: [],
      alsoMatched: [],
      uncovered: [],
      notes: [],
    },
    running: false,
    failed: null,
    stale: null,
  };

  it('saves one brief change at a time: Pin and Save answers lock each other', async () => {
    let finish: (b: typeof brief) => void = () => {};
    const saveBrief = vi.fn(() => new Promise<typeof brief>((r) => (finish = r)));
    tab({
      listProposals: vi.fn(async () => [proposalView()]),
      getOntologySuggestions: vi.fn(async () => suggestions),
      saveBrief,
    });
    await open('Questions');
    await userEvent.type(
      screen.getByLabelText('Which copy should be extracted?'),
      'The executed copy',
    );
    await open('Ontologies');
    await userEvent.click(await screen.findByRole('button', { name: 'Pin IDMP-O v2' }));
    await open('Questions');
    expect(screen.getByRole('button', { name: 'Save 1 answer to brief (v3)' })).toBeDisabled();
    finish({ ...brief, version: 3 });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save 1 answer to brief (v3)' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 answer to brief (v3)' }));
    await open('Ontologies');
    expect(screen.getByRole('button', { name: 'Pin IDMP-O v2' })).toBeDisabled();
    finish({ ...brief, version: 4 });
    expect(saveBrief).toHaveBeenCalledTimes(2);
  });

  it('loads the suggestions again when the survey finishes on the open tab', async () => {
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce([proposalView({ status: 'running', body: null })])
      .mockResolvedValue([proposalView()]);
    const getOntologySuggestions = vi
      .fn()
      .mockResolvedValueOnce({ record: null, running: false, failed: null, stale: null })
      .mockResolvedValue(suggestions);
    tab({ listProposals, getOntologySuggestions });
    await open('Ontologies');
    expect(await screen.findByRole('article', { name: 'IDMP-O v2' })).toBeInTheDocument();
    expect(getOntologySuggestions.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
