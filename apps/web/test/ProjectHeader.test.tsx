import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectHeader } from '../src/workbench/ProjectHeader.js';
import { gateView, projectView } from './fake-api.js';

describe('ProjectHeader', () => {
  it('shows the name, versions and id with a way back', () => {
    render(
      <ProjectHeader
        view={projectView({ draft: 4, published: 3 })}
        gate={gateView()}
        role="user"
        onTogglePolicy={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Letter' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', '#/workbench');
    expect(screen.getByText('Developing v4')).toBeInTheDocument();
    expect(screen.getByText(/v3 published/)).toBeInTheDocument();
    expect(screen.getByText('letter')).toBeInTheDocument();
  });

  it('locks Publish until the gate passes and explains why', () => {
    render(
      <ProjectHeader
        view={projectView({ draft: 4 })}
        gate={gateView({ reason: 'no complete holdout evaluation of the current draft' })}
        role="user"
        onTogglePolicy={vi.fn()}
      />,
    );
    const publish = screen.getByRole('link', { name: /^Publish v4/ });
    expect(publish).toHaveAttribute('href', '#/workbench/letter/evaluate');
    expect(publish).toHaveClass('locked');
    expect(publish).toHaveAttribute('title', 'no complete holdout evaluation of the current draft');
    expect(publish).toHaveAccessibleName(
      'Publish v4 (locked: no complete holdout evaluation of the current draft)',
    );
  });

  it('offers Publish when the gate passes', () => {
    render(
      <ProjectHeader
        view={projectView({ draft: 4 })}
        gate={gateView({
          passes: true,
          score: 0.95,
          iterationId: 'it1',
          reason: 'holdout score 95% meets the threshold 90%',
        })}
        role="user"
        onTogglePolicy={vi.fn()}
      />,
    );
    const publish = screen.getByRole('link', { name: 'Publish v4' });
    expect(publish).not.toHaveClass('locked');
  });

  it('has no Publish button without an open draft', () => {
    render(
      <ProjectHeader
        view={projectView({ draft: null, published: 3 })}
        gate={gateView()}
        role="user"
        onTogglePolicy={vi.fn()}
      />,
    );
    expect(screen.getByText('No open draft')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Publish/ })).toBeNull();
  });

  it('shows the data policy, and the switch only to admins', async () => {
    const onTogglePolicy = vi.fn();
    const { unmount } = render(
      <ProjectHeader
        view={projectView()}
        gate={gateView()}
        role="admin"
        onTogglePolicy={onTogglePolicy}
      />,
    );
    expect(screen.getByText('Local models only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow external models…' }));
    expect(onTogglePolicy).toHaveBeenCalled();
    unmount();
    const external = projectView();
    external.project.dataPolicy = 'external';
    render(
      <ProjectHeader view={external} gate={gateView()} role="user" onTogglePolicy={vi.fn()} />,
    );
    expect(screen.getByText('External models allowed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /models/ })).toBeNull();
  });
});
