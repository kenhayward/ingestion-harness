import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { ProjectPage } from '../src/workbench/ProjectPage.js';
import { fakeApi, projectView } from './fake-api.js';

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

describe('ProjectPage', () => {
  it('shows the project with tab links', async () => {
    page(fakeApi({ getProject: vi.fn(async () => projectView({ draft: 2, published: 1 })) }));
    expect(await screen.findByRole('heading', { name: 'Letter' })).toBeInTheDocument();
    expect(screen.getByText(/developing v2/)).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Project' });
    expect(screen.getByRole('link', { name: 'Brief' })).toHaveAttribute(
      'href',
      '#/workbench/letter/brief',
    );
    expect(nav).toContainElement(screen.getByRole('link', { name: 'Samples' }));
    expect(screen.getByRole('link', { name: 'Samples' })).toHaveAttribute('aria-current', 'page');
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
    await userEvent.click(screen.getByRole('button', { name: 'Allow external models' }));
    expect(confirm).toHaveBeenCalled();
    expect(api.setDataPolicy).toHaveBeenCalledWith('letter', 'external');
    expect(await screen.findByText('External models allowed')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('does not change the policy when the confirmation is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = fakeApi({ getProject: vi.fn(async () => projectView()) });
    page(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow external models' }));
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

  it('shows each drafting stage state in the tab bar', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      listStages: vi.fn(async () => [
        {
          stage: 'survey' as const,
          state: 'accepted' as const,
          completedAt: '2026-10-12T10:00:00.000Z',
        },
        {
          stage: 'outputs' as const,
          state: 'stale' as const,
          completedAt: '2026-10-12T09:00:00.000Z',
        },
        { stage: 'sections' as const, state: 'pending' as const, completedAt: null },
        { stage: 'steps' as const, state: 'pending' as const, completedAt: null },
      ]),
    });
    render(
      <ProjectPage api={api} projectId="letter" tab="outputs" onNavigate={vi.fn()} role="admin" />,
    );
    const tabs = await screen.findByRole('navigation', { name: 'Project' });
    expect(
      await within(tabs).findByRole('link', { name: /Outputs \u00b7 stale/ }),
    ).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: /Survey \u00b7 accepted/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: /^Sections$/ })).toBeInTheDocument();
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
});
