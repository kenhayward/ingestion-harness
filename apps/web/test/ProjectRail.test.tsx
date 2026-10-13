import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectRail } from '../src/workbench/ProjectRail.js';
import { projectOverview } from './fake-api.js';

const items = projectOverview().stages.map((s) =>
  s.stage === 'sections'
    ? { ...s, state: 'stale' as const, status: 'Stale — Outputs changed after it was accepted' }
    : s.stage === 'samples'
      ? { ...s, state: 'accepted' as const, status: 'Ready' }
      : s,
);

describe('ProjectRail', () => {
  it('groups the tabs under their phase headings', () => {
    render(<ProjectRail projectId="letter" tab="overview" items={items} onNavigate={vi.fn()} />);
    const rail = screen.getByRole('navigation', { name: 'Project steps' });
    expect(
      within(rail)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['Prepare', 'Draft with the model', 'Verify', 'By hand']);
    expect(
      within(rail)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(
      [
        'overview',
        'samples',
        'brief',
        'survey',
        'outputs',
        'sections',
        'steps',
        'references',
        'evaluate',
        'revise',
        'template',
        'runs',
      ].map((t) => `#/workbench/letter/${t}`),
    );
  });

  it('names each tab with its full status and marks the current one', () => {
    render(<ProjectRail projectId="letter" tab="sections" items={items} onNavigate={vi.fn()} />);
    const sections = screen.getByRole('link', {
      name: 'Sections: Stale — Outputs changed after it was accepted',
    });
    expect(sections).toHaveAttribute('aria-current', 'page');
    expect(sections).toHaveAttribute(
      'title',
      'Sections: Stale — Outputs changed after it was accepted',
    );
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Template' })).toBeInTheDocument();
    expect(sections.querySelector('svg[data-state="stale"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('shows the legend', () => {
    render(<ProjectRail projectId="letter" tab="overview" items={items} onNavigate={vi.fn()} />);
    expect(screen.getByRole('list', { name: 'Status legend' })).toBeInTheDocument();
  });

  it('works before the overview has loaded', () => {
    render(<ProjectRail projectId="letter" tab="brief" items={null} onNavigate={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Brief' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers a step picker for small screens', async () => {
    const onNavigate = vi.fn();
    render(<ProjectRail projectId="letter" tab="overview" items={items} onNavigate={onNavigate} />);
    const picker = screen.getByRole('combobox', { name: 'Project step' });
    expect(
      within(picker).getByRole('option', {
        name: 'Sections — Stale — Outputs changed after it was accepted',
      }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(picker, 'evaluate');
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/letter/evaluate');
  });
});
