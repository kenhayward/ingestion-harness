import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccuracyCard, HistoryCard } from '../src/workbench/EvaluateHistory.js';
import { iterationView, MODEL_CHOICES, publication } from './fake-api.js';

describe('AccuracyCard', () => {
  it('lists outputs worst first with bars in words, counting those at 100%', () => {
    const it0 = iterationView({
      scorecard: {
        score: 0.6,
        completed: 2,
        total: 2,
        fields: [
          { id: 'due_date', matched: 0, total: 2, accuracy: 0 },
          { id: 'total', matched: 5, total: 6, accuracy: 5 / 6 },
          { id: 'sender', matched: 2, total: 2, accuracy: 1 },
        ],
        columns: [{ id: 'lines.qty', matched: 115, total: 116, accuracy: 115 / 116 }],
      },
    });
    render(<AccuracyCard iteration={it0} threshold={0.9} />);
    const list = screen.getByRole('list', { name: 'Accuracy by output' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('code')!.textContent)).toEqual([
      'due_date',
      'total',
      'lines.qty',
    ]);
    expect(items[0]).toHaveTextContent('0% · 0 / 2');
    expect(
      within(list).getByRole('img', { name: 'due_date: 0%, 0 of 2, under 70%' }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole('img', { name: 'total: 83%, 5 of 6, under the threshold' }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole('img', { name: 'lines.qty: 99%, 115 of 116, meets the threshold' }),
    ).toBeInTheDocument();
    expect(screen.getByText('+ 1 more at 100%')).toBeInTheDocument();
    expect(screen.getByText('dev run · worst first')).toBeInTheDocument();
  });

  it('says when everything is at 100%', () => {
    const it0 = iterationView({
      scorecard: {
        score: 1,
        completed: 1,
        total: 1,
        fields: [{ id: 'a', matched: 1, total: 1, accuracy: 1 }],
        columns: [],
      },
    });
    render(<AccuracyCard iteration={it0} threshold={0.9} />);
    expect(screen.getByText('Every output and column is at 100%.')).toBeInTheDocument();
  });
});

describe('HistoryCard', () => {
  const g = crypto.randomUUID();
  const history = [
    iterationView({ id: 'h2', set: 'holdout', score: 0.88 }),
    iterationView({ id: 'x2', model: 'fast', groupId: g, score: 0.5 }),
    iterationView({ id: 'x1', model: 'default', groupId: g, score: 0.75 }),
    iterationView({ id: 'd2', uncached: true, score: 0.91 }),
    iterationView({ id: 'd1', templateVersion: 1, score: 0.8 }),
  ];
  const card = (onRestore = vi.fn()) =>
    render(
      <HistoryCard
        choices={MODEL_CHOICES}
        history={history}
        version={2}
        threshold={0.9}
        busy={false}
        onRestore={onRestore}
        publications={[publication({ version: 1, overrideReason: 'Known bad scan' })]}
      />,
    );

  it('charts template-model runs with a text alternative', () => {
    card();
    expect(
      screen.getByRole('img', {
        name: '3 runs with the recipe’s models; latest dev 91% (v2); latest holdout 88% (v2); threshold 90%',
      }),
    ).toBeInTheDocument();
  });

  it('lists every evaluation, a comparison as one row, and restores one', async () => {
    const onRestore = vi.fn();
    card(onRestore);
    const rows = within(screen.getByRole('list', { name: 'Evaluations' })).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('HOLDOUT');
    expect(rows[0]).toHaveTextContent('88%');
    expect(rows[1]).toHaveTextContent(
      'Compare · Main Production Model 75 · Model no longer offered 50',
    );
    expect(rows[2]).toHaveTextContent("Recipe's models · fresh");
    expect(rows[3]).toHaveTextContent('v1');
    const restore = within(rows[0]!).getByRole('button', { name: /^Restore v2 holdout run of / });
    expect(restore).toHaveAttribute('title', 'Replaces the open draft');
    await userEvent.click(restore);
    expect(onRestore).toHaveBeenCalledWith('h2');
  });

  it('names every Restore button by version, set and date', () => {
    card();
    const buttons = screen.getAllByRole('button', { name: /^Restore / });
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect(b).toHaveAccessibleName(/^Restore v\d+ (dev|holdout) run of /);
  });

  it('captions the threshold line on the chart', () => {
    card();
    const caption = screen.getByText('90%', { selector: '.eval-threshold-label' });
    expect(caption).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows the publications log below the history', () => {
    card();
    expect(screen.getByRole('list', { name: 'Publications' })).toHaveTextContent(
      'override: Known bad scan',
    );
  });

  it('says when nothing was evaluated', () => {
    render(
      <HistoryCard
        choices={MODEL_CHOICES}
        history={[]}
        version={2}
        threshold={0.9}
        busy={false}
        onRestore={vi.fn()}
        publications={[]}
      />,
    );
    expect(screen.getByText('No evaluations yet.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
