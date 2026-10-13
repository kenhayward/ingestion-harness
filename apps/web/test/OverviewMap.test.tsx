import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAP_BOXES, OverviewMap, OverviewStack } from '../src/workbench/OverviewMap.js';
import { projectOverview, projectView } from './fake-api.js';

const now = Date.parse('2026-10-13T12:00:00Z');
const overview = projectOverview({
  project: projectView({ draft: 4, published: 3 }),
  next: { stage: 'sections', title: 'Next: refresh Sections', reason: 'x' },
  stages: projectOverview().stages.map((s) =>
    s.stage === 'sections'
      ? {
          ...s,
          state: 'stale' as const,
          status: 'Stale — Outputs changed after it was accepted',
          metrics: [
            { label: 'Sections', value: '5', at: null },
            { label: 'Anchors found', value: '6 / 6 dev', at: null },
          ],
        }
      : s.stage === 'brief'
        ? {
            ...s,
            state: 'accepted' as const,
            status: 'Saved v3',
            metrics: [
              { label: 'Answers', value: '5', at: null },
              { label: 'Updated', value: '—', at: '2026-10-11T12:00:00Z' },
            ],
          }
        : s,
  ),
});

describe('OverviewMap', () => {
  it('lays out twelve boxes on the handoff grid', () => {
    expect(MAP_BOXES.map((b) => [b.tab, b.col, b.row])).toEqual([
      ['samples', 0, 0],
      ['brief', 1, 0],
      ['template', 2, 0],
      ['runs', 3, 0],
      ['survey', 0, 1],
      ['outputs', 1, 1],
      ['sections', 2, 1],
      ['steps', 3, 1],
      ['references', 0, 2],
      ['evaluate', 1, 2],
      ['revise', 2, 2],
      ['publish', 3, 2],
    ]);
  });

  it('makes every box a link that says its status and where it goes', () => {
    render(<OverviewMap projectId="letter" overview={overview} now={now} />);
    const map = screen.getByRole('region', { name: 'Process map' });
    expect(within(map).getAllByRole('link')).toHaveLength(12);
    const sections = within(map).getByRole('link', {
      name: 'Sections: Stale — Outputs changed after it was accepted. Open the Sections tab',
    });
    expect(sections).toHaveAttribute('href', '#/workbench/letter/sections');
    expect(sections).toHaveClass('is-next');
    expect(sections).toHaveTextContent('05');
    expect(sections).toHaveTextContent('Anchors found');
    expect(sections).toHaveTextContent('6 / 6 dev');
    const publish = within(map).getByRole('link', { name: /^Publish v4: / });
    expect(publish).toHaveAttribute('href', '#/workbench/letter/evaluate');
    expect(publish.getAttribute('aria-label')).toMatch(/Open the Evaluate tab$/);
  });

  it("describes each box link with its figures, which the link's name leaves out", () => {
    render(<OverviewMap projectId="letter" overview={overview} now={now} />);
    const sections = screen.getByRole('link', { name: /^Sections: / });
    expect(sections).toHaveAccessibleDescription(/Anchors found 6 \/ 6 dev/);
    expect(screen.getByRole('link', { name: /^Brief: / })).toHaveAccessibleDescription(
      /Updated 2 days ago/,
    );
  });

  it('gives each map its own arrow marker ids', () => {
    const { container } = render(
      <>
        <OverviewMap projectId="letter" overview={overview} now={now} />
        <OverviewMap projectId="letter" overview={overview} now={now} />
      </>,
    );
    const ids = [...container.querySelectorAll('marker')].map((m) => m.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const svg of container.querySelectorAll('svg.map-connectors')) {
      const own = [...svg.querySelectorAll('marker')].map((m) => `url(#${m.id})`);
      for (const path of svg.querySelectorAll('path[marker-end]'))
        expect(own).toContain(path.getAttribute('marker-end'));
    }
  });

  it('gives the Template box a soft border', () => {
    render(<OverviewMap projectId="letter" overview={overview} now={now} />);
    const template = screen.getByRole('link', { name: /^Template: / });
    expect(template.getAttribute('style')).toContain('border: 1px solid var(--ih-band-bd)');
  });

  it('shows times as relative time', () => {
    render(<OverviewMap projectId="letter" overview={overview} now={now} />);
    expect(screen.getByRole('link', { name: /^Brief: / })).toHaveTextContent('2 days ago');
  });

  it('groups the boxes in four labelled phase panels and hides the connectors', () => {
    const { container } = render(<OverviewMap projectId="letter" overview={overview} now={now} />);
    for (const name of [
      'Prepare',
      'Edit and test by hand',
      'Draft with the model',
      'Verify and publish',
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    expect(container.querySelector('svg.map-connectors')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('publish; verifying is optional')).toBeInTheDocument();
    expect(screen.getByText('hand edits change the draft')).toBeInTheDocument();
    expect(screen.getByText('revision changes the draft')).toBeInTheDocument();
  });
});

describe('OverviewStack', () => {
  it('lists the same twelve boxes in stage order under phase headings', () => {
    render(<OverviewStack projectId="letter" overview={overview} now={now} />);
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Prepare',
      'Draft with the model',
      'Verify and publish',
      'Edit and test by hand',
    ]);
    const names = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('aria-label')!.split(':')[0]);
    expect(names).toEqual([
      'Samples',
      'Brief',
      'Survey',
      'Outputs',
      'Sections',
      'Steps',
      'References',
      'Evaluate',
      'Revise',
      'Publish v4',
      'Template',
      'Test runs',
    ]);
  });
});
