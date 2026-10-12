import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '@ih/shared';
import { WorkbenchPage } from '../src/workbench/WorkbenchPage.js';
import { fakeApi, projectView } from './fake-api.js';

describe('WorkbenchPage', () => {
  it('lists projects with their versions and sample counts', async () => {
    const api = fakeApi({
      listProjects: vi.fn(async (): Promise<ProjectSummary[]> => [
        {
          id: 'letter',
          name: 'Letter',
          createdAt: '',
          dataPolicy: 'local',
          dataPolicyChangedAt: null,
          dataPolicyChangedBy: null,
          publishThreshold: 0.9,
          draft: 2,
          published: 1,
          samples: 5,
        },
      ]),
    });
    render(<WorkbenchPage api={api} onNavigate={vi.fn()} />);
    const table = await screen.findByRole('table', { name: 'Projects' });
    const row = within(table).getByRole('link', { name: 'Letter' }).closest('tr')!;
    expect(within(row).getByRole('link', { name: 'Letter' })).toHaveAttribute(
      'href',
      '#/workbench/letter',
    );
    expect(row).toHaveTextContent('v2');
    expect(row).toHaveTextContent('v1');
    expect(row).toHaveTextContent('5');
  });

  it('creates a project and opens it', async () => {
    const onNavigate = vi.fn();
    const api = fakeApi({ createProject: vi.fn(async () => projectView()) });
    render(<WorkbenchPage api={api} onNavigate={onNavigate} />);
    await userEvent.type(screen.getByLabelText('Id'), 'letter');
    await userEvent.type(screen.getByLabelText('Name'), 'Letter');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(api.createProject).toHaveBeenCalledWith('letter', 'Letter');
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/letter');
  });

  it('opens an existing document type without a name', async () => {
    const api = fakeApi({ createProject: vi.fn(async () => projectView()) });
    render(<WorkbenchPage api={api} onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Id'), 'letter');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(api.createProject).toHaveBeenCalledWith('letter', undefined);
  });
});
