import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PinButton, ProjectTable, ScoreBar } from '../src/workbench/ProjectTable.js';
import { projectListItem } from './fake-api.js';

const now = Date.parse('2026-10-13T12:00:00Z');

describe('PinButton', () => {
  it('toggles with a pressed state and the project name', async () => {
    const onToggle = vi.fn();
    render(<PinButton name="Supplier invoice" pinned={false} onToggle={onToggle} />);
    const star = screen.getByRole('button', { name: 'Pin Supplier invoice' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(star);
    expect(onToggle).toHaveBeenCalled();
  });
});

describe('ScoreBar', () => {
  it.each([
    [0.97, 0.9, '97%', 'ok', 'Holdout score 97%, publish threshold 90%'],
    [0.86, 0.9, '86%', 'warn', 'Holdout score 86%, publish threshold 90%'],
    [null, 0.9, '—', null, 'No holdout score; publish threshold 90%'],
  ] as const)('%s against %s', (score, threshold, text, tone, label) => {
    const { container } = render(<ScoreBar score={score} threshold={threshold} />);
    expect(container).toHaveTextContent(text);
    expect(screen.getByRole('img', { name: label })).toBeInTheDocument();
    if (tone) expect(container.querySelector('.score-value')).toHaveAttribute('data-tone', tone);
  });
});

describe('ProjectTable', () => {
  const items = [
    projectListItem({ id: 'letter', name: 'Letter', dataPolicy: 'external' }),
    projectListItem({
      id: 'invoice',
      name: 'Invoice',
      draft: null,
      published: 3,
      phase: 'published',
      done: 10,
      next: { kind: 'start_version', stage: null, label: 'Start v4' },
      holdoutScore: 0.95,
    }),
  ];

  it('shows one row per project with every column', () => {
    render(
      <ProjectTable items={items} pinned={new Set(['letter'])} onTogglePin={vi.fn()} now={now} />,
    );
    const table = within(screen.getByRole('region', { name: 'Projects' })).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Pin',
      'Document type',
      'Progress',
      'Next action',
      'Versions',
      'Holdout score',
      'Samples',
      'Activity',
    ]);
    const [, first, second] = within(table).getAllByRole('row');
    expect(within(first!).getByRole('link', { name: 'Letter' })).toHaveAttribute(
      'href',
      '#/workbench/letter',
    );
    expect(within(first!).getByText('EXT')).toBeInTheDocument();
    expect(within(first!).getByRole('button', { name: 'Pin Letter' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(first!).getByText('Draft · 5 of 10 done')).toBeInTheDocument();
    expect(within(first!).getByRole('link', { name: 'Decide on Steps' })).toHaveAttribute(
      'href',
      '#/workbench/letter/steps',
    );
    expect(within(first!).getByText('Draft v2')).toBeInTheDocument();
    expect(within(first!).getByText('Live v1')).toBeInTheDocument();
    expect(within(first!).getByText('4 dev · 2 hold')).toBeInTheDocument();
    expect(within(first!).getByText('4 h ago')).toBeInTheDocument();
    expect(within(first!).getByRole('img', { name: /^Progress: / })).toBeInTheDocument();
    expect(within(second!).getByText('Published · no open draft')).toBeInTheDocument();
    expect(within(second!).getByText('Start v4')).toBeInTheDocument();
    expect(within(second!).queryByText('EXT')).toBeNull();
  });

  it('also lists the projects as cards for phones', () => {
    render(<ProjectTable items={items} pinned={new Set()} onTogglePin={vi.fn()} now={now} />);
    const cards = screen.getByRole('list', { name: 'Projects as cards' });
    expect(within(cards).getAllByRole('listitem')).toHaveLength(2);
    expect(within(cards).getByRole('link', { name: 'Letter' })).toHaveAttribute(
      'href',
      '#/workbench/letter',
    );
  });
});
