import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverviewTab } from '../src/workbench/OverviewTab.js';
import { projectOverview } from './fake-api.js';

describe('OverviewTab', () => {
  it('leads with the next step and links to its tab', () => {
    render(
      <OverviewTab
        projectId="letter"
        overview={projectOverview({
          next: {
            stage: 'sections',
            title: 'Next: refresh Sections',
            reason: 'An earlier stage changed after Sections was accepted.',
          },
        })}
      />,
    );
    const note = screen.getByRole('note');
    expect(within(note).getByText('Next: refresh Sections')).toBeInTheDocument();
    expect(
      within(note).getByText('An earlier stage changed after Sections was accepted.'),
    ).toBeInTheDocument();
    expect(within(note).getByRole('link', { name: 'Open Sections' })).toHaveAttribute(
      'href',
      '#/workbench/letter/sections',
    );
  });

  it('sends Publish to the Evaluate tab', () => {
    render(
      <OverviewTab
        projectId="letter"
        overview={projectOverview({
          next: {
            stage: 'publish',
            title: 'Next: publish v2',
            reason: 'Holdout score 93% meets the threshold 90%.',
          },
        })}
      />,
    );
    expect(screen.getByRole('link', { name: 'Open Evaluate' })).toHaveAttribute(
      'href',
      '#/workbench/letter/evaluate',
    );
  });

  it('shows the next stage state as an icon at the start of the banner', () => {
    const base = projectOverview();
    const { container } = render(
      <OverviewTab
        projectId="letter"
        overview={{
          ...base,
          stages: base.stages.map((s) =>
            s.stage === 'sections' ? { ...s, state: 'stale' as const } : s,
          ),
          next: { stage: 'sections', title: 'Next: refresh Sections', reason: 'x' },
        }}
      />,
    );
    const icon = container.querySelector('.next-banner .next-banner-tile svg.stage-icon');
    expect(icon).toHaveAttribute('data-state', 'stale');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    // The icon tile takes the stage tone's fill (Stale: the alert background).
    expect(container.querySelector('.next-banner-tile')!.getAttribute('style')).toContain(
      'background: var(--ih-alert-bg)',
    );
  });

  it('gives the Recipe box its title and status but no status icon', () => {
    render(<OverviewTab projectId="letter" overview={projectOverview()} />);
    const map = screen.getByRole('region', { name: 'Process map' });
    const box = within(map).getByRole('link', { name: /^Recipe:/ });
    expect(box).toHaveTextContent('Recipe');
    expect(box).toHaveTextContent('Draft v1');
    expect(box.querySelector('svg.stage-icon')).toBeNull();
  });

  it('shows the map, the narrow-screen stack and the caption, and no banner when nothing is next', () => {
    render(<OverviewTab projectId="letter" overview={projectOverview()} now={0} />);
    expect(screen.queryByRole('note')).toBeNull();
    const map = screen.getByRole('region', { name: 'Process map' });
    expect(within(map).getAllByRole('link')).toHaveLength(13);
    expect(
      within(map).getByRole('link', { name: 'Samples: Not started. Open the Samples tab' }),
    ).toHaveAttribute('href', '#/workbench/letter/samples');
    const stack = screen.getByRole('group', { name: 'Stages' });
    expect(within(stack).getAllByRole('link')).toHaveLength(13);
    expect(screen.getByText(/Click any box to open its tab\./)).toBeInTheDocument();
  });
});
