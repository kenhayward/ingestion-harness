import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { ProjectPage } from '../src/workbench/ProjectPage.js';
import { fakeApi, projectView } from './fake-api.js';

const page = (api = fakeApi(), tab: 'samples' | 'brief' | 'template' | 'runs' = 'samples') =>
  render(
    <ProjectPage api={api} projectId="letter" tab={tab} onNavigate={vi.fn()} pollMs={60_000} />,
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
});
