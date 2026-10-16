import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { ProjectPage } from '../src/workbench/ProjectPage.js';
import { recentProjects } from '../src/workbench/listDerive.js';
import { OVERVIEW_TABS, type DraftChange, type OverviewItem } from '@ih/shared';
import {
  changeProposalView,
  fakeApi,
  feedbackItem,
  projectOverview,
  reviseProposal,
  projectView,
  publication,
  templateView,
} from './fake-api.js';
import { validDefinition } from './template-fixture.js';

/** The fixture overview with some items replaced. */
const overviewWith = (
  items: Partial<Record<OverviewItem['stage'], Omit<OverviewItem, 'stage' | 'metrics'>>>,
) =>
  projectOverview({
    stages: projectOverview().stages.map((s) => {
      const item = items[s.stage];
      return item ? { stage: s.stage, metrics: s.metrics, ...item } : s;
    }),
  });

const page = (api = fakeApi(), tab: 'samples' | 'brief' | 'template' | 'runs' = 'samples') =>
  render(
    <ProjectPage
      api={api}
      projectId="letter"
      tab={tab}
      onNavigate={vi.fn()}
      pollMs={60_000}
      role="admin"
    />,
  );

const TAB_TITLES = [
  ['samples', 'Samples'],
  ['brief', 'Brief'],
  ['survey', 'Survey'],
  ['outputs', 'Outputs'],
  ['sections', 'Section anchors'],
  ['steps', 'Extraction steps'],
  ['references', 'References'],
  ['evaluate', 'Evaluate'],
  ['revise', 'Revise'],
  ['template', 'Transformation recipe · draft v1'],
  ['runs', 'Test runs'],
] as const;

describe('ProjectPage tab headers', () => {
  it.each(TAB_TITLES)('opens the %s tab with the H2 %s and its status', async (tab, title) => {
    const stages = OVERVIEW_TABS.map((stage) => [
      stage,
      { state: 'accepted' as const, status: 'Accepted' },
    ]);
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 1 })),
      getProjectOverview: vi.fn(async () => overviewWith(Object.fromEntries(stages))),
    });
    render(
      <ProjectPage
        api={api}
        projectId="letter"
        tab={tab}
        onNavigate={vi.fn()}
        pollMs={60_000}
        role="admin"
      />,
    );
    expect(await screen.findByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2, name: title })).toHaveLength(1);
    await waitFor(() => {
      const header = screen.getByRole('heading', { level: 2, name: title }).closest('header')!;
      expect(within(header).getByText('Accepted')).toBeInTheDocument();
    });
  });

  it('has one Ask button and no Skip on the Revise tab', async () => {
    const api = fakeApi({ getProject: vi.fn(async () => projectView({ draft: 1 })) });
    render(
      <ProjectPage
        api={api}
        projectId="letter"
        tab="revise"
        onNavigate={vi.fn()}
        pollMs={60_000}
        role="admin"
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Revise' });
    expect(
      await screen.findAllByRole('button', { name: 'Ask the model for a revision' }),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Skip this stage' })).toBeNull();
  });

  it('reloads the overview after feedback is added and after Ask on the Revise tab', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 1 })),
      addFeedback: vi.fn(async () => feedbackItem()),
      startStage: vi.fn(async () => reviseProposal({ status: 'running', body: null })),
    });
    render(
      <ProjectPage
        api={api}
        projectId="letter"
        tab="revise"
        onNavigate={vi.fn()}
        pollMs={60_000}
        role="admin"
      />,
    );
    await screen.findByRole('textbox', { name: 'Feedback' });
    await waitFor(() => expect(api.getProjectOverview).toHaveBeenCalled());
    const before = vi.mocked(api.getProjectOverview).mock.calls.length;
    await userEvent.type(screen.getByRole('textbox', { name: 'Feedback' }), 'Use the letterhead');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(vi.mocked(api.getProjectOverview).mock.calls.length).toBeGreaterThan(before),
    );
    const afterAdd = vi.mocked(api.getProjectOverview).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Ask the model for a revision' }));
    await waitFor(() =>
      expect(vi.mocked(api.getProjectOverview).mock.calls.length).toBeGreaterThan(afterAdd),
    );
  });

  it('still shows the Samples title when the overview cannot load', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      getProjectOverview: vi.fn(async () => {
        throw new Error('overview down');
      }),
    });
    page(api);
    expect(await screen.findByRole('heading', { level: 2, name: 'Samples' })).toBeInTheDocument();
  });
});

describe('ProjectPage', () => {
  it('loads the draft and live definitions on the Outputs tab', async () => {
    const getTemplate = vi.fn(async (_id: string, version: number) =>
      templateView({ id: 'letter', version, outputs: { fields: [], tables: [] } }),
    );
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 2, published: 1 })),
      getTemplate,
    });
    render(
      <ProjectPage
        api={api}
        projectId="letter"
        tab="outputs"
        onNavigate={vi.fn()}
        pollMs={60_000}
        role="admin"
      />,
    );
    await waitFor(() => expect(getTemplate).toHaveBeenCalledWith('letter', 2));
    expect(getTemplate).toHaveBeenCalledWith('letter', 1);
  });

  it('keeps JUST ADDED on the Steps tab after applying a proposal refreshes the page', async () => {
    const before = {
      id: 'letter',
      version: 2,
      outputs: { fields: [{ id: 'total' }], tables: [] },
      pipeline: [{ type: 'extract', id: 'header', fields: ['total'], sections: ['header'] }],
    };
    const added = { type: 'check', id: 'totals-match', values: 'total', reference: 'total' };
    const after = { ...before, pipeline: [...before.pipeline, added] };
    const proposal = changeProposalView({
      stage: 'steps',
      body: {
        notes: '',
        changes: [
          { op: 'putStep', reason: 'Catches drops', step: added },
        ] as unknown as DraftChange[],
      },
    });
    let current: Record<string, unknown> = before;
    const getProject = vi.fn(async () => projectView({ draft: 2 }));
    const api = fakeApi({
      getProject,
      getProjectOverview: vi.fn(async () => projectOverview()),
      getMetrics: vi.fn(async () => ({
        templateId: 'letter',
        versions: [],
        topEdited: [],
        steps: [],
      })),
      listProposals: vi.fn(async () => [proposal]),
      getTemplate: vi.fn(async () => templateView(current)),
      decideProposal: vi.fn(async () => {
        current = after;
        return { ...proposal, status: 'accepted' as const, acceptedChanges: [0] };
      }),
    });
    render(
      <ProjectPage
        api={api}
        projectId="letter"
        tab="steps"
        onNavigate={vi.fn()}
        pollMs={60_000}
        role="admin"
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Apply 1 selected change' }));
    const card = await screen.findByRole('listitem', { name: 'Step 2: totals-match' });
    expect(within(card).getByText('JUST ADDED')).toBeInTheDocument();
    // The page's changed() refresh reloaded the project; the tab was not remounted.
    await waitFor(() => expect(getProject.mock.calls.length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(
      within(screen.getByRole('listitem', { name: 'Step 2: totals-match' })).getByText(
        'JUST ADDED',
      ),
    ).toBeInTheDocument();
  });

  it('remembers the project first among the recent projects', async () => {
    localStorage.setItem('ih.wbRecent', JSON.stringify(['invoice', 'letter']));
    page(fakeApi({ getProject: vi.fn(async () => projectView()) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Letter' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('ih.wbRecent')!)).toEqual(['letter', 'invoice']);
  });

  it('shows the project with tab links', async () => {
    page(fakeApi({ getProject: vi.fn(async () => projectView({ draft: 2, published: 1 })) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Letter' })).toBeInTheDocument();
    expect(await screen.findByText('Developing v2')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Project steps' });
    expect(within(nav).getByRole('link', { name: 'Brief: Not started' })).toHaveAttribute(
      'href',
      '#/workbench/letter/brief',
    );
    expect(within(nav).getByRole('link', { name: 'Samples: Not started' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.queryByRole('navigation', { name: 'Project' })).toBeNull();
  });

  it('opens on the Overview tab with the next step', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      getProjectOverview: vi.fn(async () =>
        projectOverview({
          next: {
            stage: 'samples',
            title: 'Next: add sample documents',
            reason: 'Upload 3–8 dev samples and a few holdout samples.',
          },
        }),
      ),
    });
    render(
      <ProjectPage
        api={api}
        projectId="letter"
        tab="overview"
        onNavigate={vi.fn()}
        pollMs={60_000}
        role="admin"
      />,
    );
    expect(await screen.findByText('Next: add sample documents')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('resets the project from the Overview tab once its id is typed', async () => {
    localStorage.setItem('ih.briefDraft.letter', JSON.stringify({ base: 1, value: {} }));
    localStorage.setItem('ih.recipeDraft.letter.1', JSON.stringify({ base: 'x', value: {} }));
    localStorage.setItem('ih.briefDraft.letters', JSON.stringify({ base: 1, value: {} }));
    const getProjectOverview = vi.fn(async () => projectOverview());
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      getProjectOverview,
      resetProject: vi.fn(async () => projectView()),
    });
    render(
      <ProjectPage
        api={api}
        projectId="letter"
        tab="overview"
        onNavigate={vi.fn()}
        pollMs={60_000}
        role="designer"
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Reset project…' }));
    const form = screen.getByRole('form', { name: 'Reset project' });
    expect(form).toHaveTextContent(/keeps the samples and the brief's written sections/);
    const submit = within(form).getByRole('button', { name: 'Reset project' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(form).getByLabelText('Type letter to confirm'), 'letter');
    const loads = getProjectOverview.mock.calls.length;
    await userEvent.click(submit);
    expect(api.resetProject).toHaveBeenCalledWith('letter');
    expect(await screen.findByRole('status')).toHaveTextContent('Project reset');
    expect(getProjectOverview.mock.calls.length).toBeGreaterThan(loads);
    expect(localStorage.getItem('ih.briefDraft.letter')).toBeNull();
    expect(localStorage.getItem('ih.recipeDraft.letter.1')).toBeNull();
    expect(localStorage.getItem('ih.briefDraft.letters')).not.toBeNull();
    localStorage.clear();
  });

  it('polls the overview only while something is running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const running = overviewWith({ samples: { state: 'running', status: 'Preparing 1 of 1' } });
      const getProjectOverview = vi
        .fn()
        .mockResolvedValueOnce(running)
        .mockResolvedValue(projectOverview());
      const api = fakeApi({ getProject: vi.fn(async () => projectView()), getProjectOverview });
      const { unmount } = render(
        <ProjectPage
          api={api}
          projectId="letter"
          tab="overview"
          onNavigate={vi.fn()}
          pollMs={1000}
          role="admin"
        />,
      );
      const nav = await screen.findByRole('navigation', { name: 'Project steps' });
      await within(nav).findByRole('link', { name: 'Samples: Preparing 1 of 1' });
      await vi.advanceTimersByTimeAsync(1000);
      await within(nav).findByRole('link', { name: 'Samples: Not started' });
      const calls = getProjectOverview.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(getProjectOverview.mock.calls.length).toBe(calls);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refetches the overview when the window regains focus', async () => {
    const getProjectOverview = vi.fn(async () => projectOverview());
    const api = fakeApi({ getProject: vi.fn(async () => projectView()), getProjectOverview });
    const { unmount } = page(api);
    await screen.findByRole('navigation', { name: 'Project steps' });
    const calls = getProjectOverview.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    expect(getProjectOverview.mock.calls.length).toBe(calls + 1);
    unmount();
    window.dispatchEvent(new Event('focus'));
    expect(getProjectOverview.mock.calls.length).toBe(calls + 1);
  });

  it('shows an overview failure, keeps the header and retries', async () => {
    const getProjectOverview = vi
      .fn()
      .mockRejectedValueOnce(new Error('service unavailable'))
      .mockResolvedValue(projectOverview());
    const api = fakeApi({ getProject: vi.fn(async () => projectView()), getProjectOverview });
    page(api);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the project status: service unavailable',
    );
    expect(screen.getByRole('button', { name: 'Allow external models…' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(getProjectOverview).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await screen.findByRole('link', { name: 'Samples: Not started' })).toBeInTheDocument();
  });

  it('refetches the overview when the tab changes', async () => {
    const getProjectOverview = vi.fn(async () => projectOverview());
    const api = fakeApi({ getProject: vi.fn(async () => projectView()), getProjectOverview });
    const props = {
      api,
      projectId: 'letter',
      onNavigate: vi.fn(),
      pollMs: 60_000,
      role: 'admin' as const,
    };
    const { rerender } = render(<ProjectPage {...props} tab="overview" />);
    await screen.findByRole('navigation', { name: 'Project steps' });
    await waitFor(() => expect(getProjectOverview).toHaveBeenCalledTimes(1));
    rerender(<ProjectPage {...props} tab="brief" />);
    await waitFor(() => expect(getProjectOverview).toHaveBeenCalledTimes(2));
  });

  it('ignores an older overview that arrives after a newer one', async () => {
    let resolveFirst: (o: ReturnType<typeof projectOverview>) => void = () => undefined;
    const getProjectOverview = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(overviewWith({ samples: { state: 'accepted', status: 'Ready: 3 dev' } }));
    const api = fakeApi({ getProject: vi.fn(async () => projectView()), getProjectOverview });
    page(api);
    await screen.findByRole('navigation', { name: 'Project steps' });
    window.dispatchEvent(new Event('focus'));
    await screen.findByRole('link', { name: 'Samples: Ready: 3 dev' });
    resolveFirst(projectOverview());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('link', { name: 'Samples: Ready: 3 dev' })).toBeInTheDocument();
  });

  it('offers the drafting bundle export on the Brief tab', async () => {
    page(fakeApi({ getProject: vi.fn(async () => projectView()) }), 'brief');
    expect(await screen.findByRole('heading', { name: 'Drafting bundle' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export bundle' })).toBeInTheDocument();
  });

  it('offers to open a document type that has no project yet', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => {
        throw new ApiError('project not found', 404);
      }),
      createProject: vi.fn(async () => projectView()),
    });
    page(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Open in workbench' }));
    expect(api.createProject).toHaveBeenCalledWith('letter');
    expect(await screen.findByRole('heading', { name: 'Letter' })).toBeInTheDocument();
  });

  it('starts the next version when every version is published', async () => {
    const getProject = vi
      .fn()
      .mockResolvedValueOnce(projectView({ draft: null, published: 1 }))
      .mockResolvedValue(projectView({ draft: 2, published: 1 }));
    const api = fakeApi({ getProject, newDraft: vi.fn(async () => ({}) as never) });
    page(api, 'template');
    await userEvent.click(await screen.findByRole('button', { name: 'Start v2' }));
    expect(api.newDraft).toHaveBeenCalledWith('letter', 1);
    expect(getProject).toHaveBeenCalledTimes(2);
  });

  it('refreshes the overview after starting the next version', async () => {
    const getProjectOverview = vi.fn(async () => projectOverview());
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: null, published: 1 })),
      getProjectOverview,
      newDraft: vi.fn(async () => ({}) as never),
    });
    page(api, 'template');
    const start = await screen.findByRole('button', { name: 'Start v2' });
    await waitFor(() => expect(getProjectOverview).toHaveBeenCalled());
    const calls = getProjectOverview.mock.calls.length;
    await userEvent.click(start);
    expect(api.newDraft).toHaveBeenCalledWith('letter', 1);
    await waitFor(() => expect(getProjectOverview.mock.calls.length).toBeGreaterThan(calls));
  });

  it('deletes an unpublished project once its id is typed, then opens the Workbench list', async () => {
    const onNavigate = vi.fn();
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 1, published: null })),
      deleteProject: vi.fn(async () => undefined),
    });
    render(
      <ProjectPage
        api={api}
        projectId="letter"
        tab="samples"
        onNavigate={onNavigate}
        pollMs={60_000}
        role="designer"
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Delete project' }));
    const confirmBox = screen.getByLabelText('Type letter to confirm');
    const submit = screen.getByRole('button', { name: 'Delete project' });
    expect(submit).toBeDisabled();
    await userEvent.type(confirmBox, 'lettr');
    expect(submit).toBeDisabled();
    await userEvent.type(confirmBox, '{Enter}');
    expect(api.deleteProject).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();

    await userEvent.clear(confirmBox);
    await userEvent.type(confirmBox, 'letter');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(api.deleteProject).toHaveBeenCalledWith('letter');
    expect(onNavigate).toHaveBeenCalledWith('#/workbench');
    expect(recentProjects()).not.toContain('letter');
  });

  it('shows why a delete was refused', async () => {
    const onNavigate = vi.fn();
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 1, published: null })),
      deleteProject: vi.fn(async () => {
        throw new ApiError(
          'letter has a published version; published document types keep their project',
          409,
        );
      }),
    });
    render(
      <ProjectPage
        api={api}
        projectId="letter"
        tab="samples"
        onNavigate={onNavigate}
        pollMs={60_000}
        role="admin"
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Delete project' }));
    await userEvent.type(screen.getByLabelText('Type letter to confirm'), 'letter');
    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'letter has a published version; published document types keep their project',
    );
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('shows the data policy and lets an admin allow external models after confirming', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      setDataPolicy: vi.fn(async () =>
        projectView({ project: { ...projectView().project, dataPolicy: 'external' } }),
      ),
    });
    page(api);
    expect(await screen.findByText('Local models only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow external models…' }));
    expect(confirm).toHaveBeenCalled();
    expect(api.setDataPolicy).toHaveBeenCalledWith('letter', 'external');
    expect(await screen.findByText('External models allowed')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('does not change the policy when the confirmation is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = fakeApi({ getProject: vi.fn(async () => projectView()) });
    page(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow external models…' }));
    expect(api.setDataPolicy).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('hides the policy switch from users', async () => {
    render(
      <ProjectPage
        api={fakeApi({ getProject: vi.fn(async () => projectView()) })}
        projectId="letter"
        tab="samples"
        onNavigate={vi.fn()}
        role="designer"
      />,
    );
    expect(await screen.findByText('Local models only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /external models/i })).toBeNull();
  });

  it('shows each drafting stage state in the step rail', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      getProjectOverview: vi.fn(async () =>
        overviewWith({
          survey: { state: 'accepted', status: 'Accepted' },
          outputs: { state: 'stale', status: 'Stale — Survey changed after it was accepted' },
        }),
      ),
    });
    render(
      <ProjectPage api={api} projectId="letter" tab="outputs" onNavigate={vi.fn()} role="admin" />,
    );
    const rail = await screen.findByRole('navigation', { name: 'Project steps' });
    expect(
      await within(rail).findByRole('link', {
        name: 'Outputs: Stale — Survey changed after it was accepted',
      }),
    ).toBeInTheDocument();
    expect(within(rail).getByRole('link', { name: 'Survey: Accepted' })).toBeInTheDocument();
    expect(within(rail).getByRole('link', { name: 'Sections: Not started' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Propose outputs' })).toBeInTheDocument();
  });

  it('shows the anchor proposals above the Sections editor', async () => {
    render(
      <ProjectPage
        api={fakeApi({ getProject: vi.fn(async () => projectView()) })}
        projectId="letter"
        tab="sections"
        onNavigate={vi.fn()}
        role="admin"
      />,
    );
    expect(
      await screen.findByRole('button', { name: 'Propose section anchors' }),
    ).toBeInTheDocument();
  });
  it('disables Keep these anchors while the Sections editor has unsaved anchors', async () => {
    render(
      <ProjectPage
        api={fakeApi({
          getProject: vi.fn(async () => projectView()),
          getTemplate: vi.fn(async () =>
            templateView({
              id: 'letter',
              version: 1,
              name: 'Letter',
              document: { ocr: 'auto', sections: [{ id: 'all', anchor: '^HEADER' }] },
              outputs: { fields: [] },
              pipeline: [],
            }),
          ),
          listProposals: vi.fn(async () => [
            changeProposalView({ stage: 'sections', status: 'accepted' }),
          ]),
          getProjectOverview: vi.fn(async () =>
            overviewWith({
              sections: { state: 'stale', status: 'Stale — Outputs changed after it was accepted' },
            }),
          ),
        })}
        projectId="letter"
        tab="sections"
        onNavigate={vi.fn()}
        pollMs={60_000}
        role="admin"
      />,
    );
    const keep = await screen.findByRole('button', { name: 'Keep these anchors' });
    expect(keep).toBeEnabled();
    await userEvent.click(await screen.findByRole('button', { name: /Add section/ }));
    await waitFor(() => expect(keep).toBeDisabled());
    expect(keep).toHaveAttribute('title', 'Save your unsaved anchors first');
  });

  it('shows the references stage state and renders the References and Evaluate tabs', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      getProjectOverview: vi.fn(async () =>
        overviewWith({ references: { state: 'proposed', status: 'Needs your decision' } }),
      ),
    });
    const { unmount } = render(
      <ProjectPage
        api={api}
        projectId="letter"
        tab="references"
        onNavigate={vi.fn()}
        role="admin"
      />,
    );
    const rail = await screen.findByRole('navigation', { name: 'Project steps' });
    expect(
      await within(rail).findByRole('link', { name: 'References: Needs your decision' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /^Run the draft model on \d+ unverified…$/ }),
    ).toBeInTheDocument();
    unmount();
    render(
      <ProjectPage api={api} projectId="letter" tab="evaluate" onNavigate={vi.fn()} role="admin" />,
    );
    expect(await screen.findByRole('button', { name: 'Evaluate v1 on dev…' })).toBeInTheDocument();
  });
  it('refreshes the page overview after publishing from the Template tab', async () => {
    const getProjectOverview = vi.fn(async () => projectOverview());
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 2, published: 1 })),
      getProjectOverview,
      getTemplate: vi.fn(async () => templateView({ ...validDefinition(), version: 2 })),
      publish: vi.fn(async () => ({ publication: publication(), project: projectView() })),
    });
    page(api, 'template');
    const publish = await screen.findByRole('button', { name: /^Publish v2/ });
    await waitFor(() => expect(publish).toBeEnabled());
    const calls = getProjectOverview.mock.calls.length;
    await userEvent.click(publish);
    await waitFor(() => expect(api.publish).toHaveBeenCalled());
    await waitFor(() => expect(getProjectOverview.mock.calls.length).toBeGreaterThan(calls));
  });

  it("passes the overview's stale stages to the Template tab and refreshes the overview after a save", async () => {
    const getProjectOverview = vi.fn(async () =>
      overviewWith({
        steps: { state: 'stale', status: 'Stale — Sections changed after it was accepted' },
      }),
    );
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 2, published: 1 })),
      getProjectOverview,
      getTemplate: vi.fn(async () => templateView({ ...validDefinition(), version: 2 })),
    });
    page(api, 'template');
    const checks = await screen.findByRole('region', { name: 'Checks' });
    expect(
      await within(checks).findByRole('link', { name: 'Review in Steps' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Changes since v1' })).toBeInTheDocument();
    const calls = getProjectOverview.mock.calls.length;
    await userEvent.click(screen.getByRole('tab', { name: /^General/ }));
    await userEvent.type(screen.getByLabelText('Name'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft v2' }));
    await waitFor(() => expect(getProjectOverview.mock.calls.length).toBeGreaterThan(calls));
  });
});

describe('ProjectPage of a retired type (D7, D14, D18)', () => {
  const retired = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };
  it('still opens, with the banner naming the unretire route and no Unretire, even for admins', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ retired })),
      getProjectOverview: vi.fn(async () => projectOverview()),
    });
    page(api, 'brief');
    await screen.findByText(/Retired by ken on 14 Oct 2026/);
    const banner = screen
      .getAllByRole('note')
      .find((n) => n.textContent?.includes('Retired by ken on 14 Oct 2026'));
    expect(banner).toHaveTextContent('DELETE /api/specs/letter/retirement');
    expect(screen.queryByRole('button', { name: /unretire/i })).toBeNull();
    expect(api).not.toHaveProperty('unretireType');
  });

  it('opens the Recipe tab read-only from the projects own retired flag (M4)', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 1, retired })),
      getProjectOverview: vi.fn(async () => projectOverview()),
      getTemplate: vi.fn(async () => templateView({ id: 'letter', version: 1 })),
      listTemplates: vi.fn(async () => []), // the editor's own lookup would say "active"
    });
    page(api, 'template');
    await userEvent.click(await screen.findByRole('tab', { name: /^General/ }));
    await waitFor(() => expect(api.listTemplates).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(await screen.findByLabelText('Name')).toBeDisabled();
  });

  it('shows no banner for an active type', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      getProjectOverview: vi.fn(async () => projectOverview()),
    });
    page(api, 'brief');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/Retired by/)).toBeNull();
  });
});
