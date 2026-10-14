import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectHeader } from '../src/workbench/ProjectHeader.js';
import { RETIRED_REASON } from '../src/ui/retired.js';
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

  it('never locks Publish: references and evaluation are optional', () => {
    render(
      <ProjectHeader
        view={projectView({ draft: 4 })}
        gate={gateView({ reason: 'no complete holdout evaluation of the current draft' })}
        role="user"
        onTogglePolicy={vi.fn()}
      />,
    );
    const publish = screen.getByRole('link', { name: 'Publish v4' });
    expect(publish).toHaveAttribute('href', '#/workbench/letter/template');
    expect(publish).not.toHaveClass('locked');
  });

  it('hides Publish while the gate is unknown but keeps the policy controls', () => {
    render(
      <ProjectHeader view={projectView()} gate={null} role="admin" onTogglePolicy={vi.fn()} />,
    );
    expect(screen.queryByRole('link', { name: /Publish/ })).toBeNull();
    expect(screen.getByText('Local models only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow external models…' })).toBeInTheDocument();
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

  it('shows Retired and disables Publish for a retired type', () => {
    render(
      <ProjectHeader
        view={projectView({
          draft: 4,
          retired: { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' },
        })}
        gate={gateView()}
        role="user"
        onTogglePolicy={vi.fn()}
      />,
    );
    expect(screen.getByText('Retired')).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: 'Publish v4' });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute('title', RETIRED_REASON);
    expect(screen.queryByRole('link', { name: 'Publish v4' })).toBeNull();
  });
});
