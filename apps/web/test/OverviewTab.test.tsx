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

  it('keeps three columns in the Template row, which has no status icon', () => {
    render(<OverviewTab projectId="letter" overview={projectOverview()} />);
    const row = screen.getByRole('link', { name: /^Template:/ });
    expect(row.children).toHaveLength(3);
    expect(row.children[1]).toHaveTextContent('Template');
  });

  it('lists every stage with its status and has no banner when nothing is next', () => {
    render(<OverviewTab projectId="letter" overview={projectOverview()} />);
    expect(screen.queryByRole('note')).toBeNull();
    const list = screen.getByRole('list', { name: 'Stages' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(12);
    expect(within(list).getByRole('link', { name: 'Samples: Not started' })).toHaveAttribute(
      'href',
      '#/workbench/letter/samples',
    );
  });
});
