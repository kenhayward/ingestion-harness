import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { ProjectPage } from '../src/workbench/ProjectPage.js';
import { OVERVIEW_TABS, type OverviewItem } from '@ih/shared';
import { fakeApi, projectOverview, projectView } from './fake-api.js';

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
  ['template', 'Template'],
  ['runs', 'Test runs'],
] as const;

describe('ProjectPage tab headers', () => {
  it.each(TAB_TITLES)('opens the %s tab with the H2 %s and its status', async (tab, title) => {
    const stages = OVERVIEW_TABS.filter((s) => s !== 'template').map((stage) => [
      stage,
      { state: 'accepted' as const, status: 'Accepted' },
    ]);
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 1 })),
      getProjectOverview: vi.fn(async () => overviewWith(Object.fromEntries(stages))),
    });
    const { container } = render(
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
    if (tab !== 'template') {
      await waitFor(() => {
        const header = container.querySelector<HTMLElement>('.tab-header')!;
        expect(within(header).getByText('Accepted')).toBeInTheDocument();
      });
    }
  });

  it('has one Propose button and no Skip on the Revise tab', async () => {
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
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^Propose (a revision|again)$/ })).toHaveLength(
        1,
      ),
    );
    expect(screen.queryByRole('button', { name: 'Skip this stage' })).toBeNull();
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
            title: 'Next: add sample PDFs',
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
    expect(await screen.findByText('Next: add sample PDFs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
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
        role="user"
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
        role="user"
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
      await screen.findByRole('button', { name: 'Run the draft model on unverified samples' }),
    ).toBeInTheDocument();
    unmount();
    render(
      <ProjectPage api={api} projectId="letter" tab="evaluate" onNavigate={vi.fn()} role="admin" />,
    );
    expect(await screen.findByRole('button', { name: 'Evaluate the draft' })).toBeInTheDocument();
  });
});
