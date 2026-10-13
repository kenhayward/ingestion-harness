import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RunBatchCard } from '../src/workbench/RunBatchCard.js';
import type { RunBatch } from '../src/workbench/runs.js';
import { testRunView } from './fake-api.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();

function batch(active = true): RunBatch {
  return {
    id: 'b1',
    createdAt: at(0),
    specVersion: 4,
    createdBy: 'ken',
    modelOverride: null,
    active,
    runs: [
      testRunView({
        id: '11111111-0000-4000-8000-000000000001',
        filename: 'acme.pdf',
        status: 'succeeded',
        startedAt: at(0),
        finishedAt: at(31),
      }),
      testRunView({
        id: '11111111-0000-4000-8000-000000000002',
        filename: 'globex.pdf',
        status: 'awaiting_review',
        reviewReasons: ['Check flagged supplier_name'],
      }),
      testRunView({
        id: '11111111-0000-4000-8000-000000000003',
        filename: 'hooli.pdf',
        status: 'running',
        startedAt: at(0),
        progress: { step: 'line_items', index: 2, of: 3, attempt: 1, chunk: { n: 2, of: 2 } },
      }),
      testRunView({
        id: '11111111-0000-4000-8000-000000000004',
        filename: 'stark.pdf',
        status: 'failed',
        error: 'invalid JSON',
        attempts: 3,
      }),
    ],
  };
}

const renderCard = (b = batch(), onRetry = vi.fn()) =>
  render(
    <RunBatchCard
      batch={b}
      title="12 Oct, 10:14 · draft v4"
      subtitle="4 dev samples · started by ken · template's models"
      now={Date.parse(at(72))}
      onRetry={onRetry}
    />,
  );
const row = (file: string) =>
  screen.getByRole('cell', { name: file }).closest('tr') as HTMLTableRowElement;

describe('RunBatchCard', () => {
  it('heads the batch with its title, subtitle and a stacked status bar with a text alternative', () => {
    renderCard();
    const card = screen.getByRole('region', { name: '12 Oct, 10:14 · draft v4' });
    expect(card).toHaveClass('runs-batch', 'is-live');
    expect(card).toHaveTextContent("4 dev samples · started by ken · template's models");
    const text = '1 succeeded · 1 awaiting review · 1 running · 1 failed';
    expect(within(card).getByRole('img', { name: `Batch status: ${text}` })).toBeInTheDocument();
    expect(within(card).getByText(text)).toBeInTheDocument();
  });

  it('is not live once nothing runs', () => {
    renderCard(batch(false));
    expect(screen.getByRole('region', { name: /draft v4/ })).not.toHaveClass('is-live');
  });

  it('shows each run with its status, detail, duration and action', () => {
    renderCard();
    expect(
      screen.getByRole('table', { name: 'Runs of 12 Oct, 10:14 · draft v4' }),
    ).toBeInTheDocument();
    const done = row('acme.pdf');
    expect(within(done).getByText('Succeeded')).toBeInTheDocument();
    expect(within(done).getByText('00:31')).toBeInTheDocument();
    expect(within(done).getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      '#/review/11111111-0000-4000-8000-000000000001',
    );
    const waiting = row('globex.pdf');
    expect(within(waiting).getByText('Check flagged supplier_name')).toBeInTheDocument();
    expect(within(waiting).getByRole('link', { name: 'Review now' })).toHaveAttribute(
      'href',
      '#/review/11111111-0000-4000-8000-000000000002',
    );
    const running = row('hooli.pdf');
    expect(within(running).getByText('01:12')).toBeInTheDocument();
    expect(within(running).queryByRole('link')).toBeNull();
    expect(
      within(row('stark.pdf')).getByText('invalid JSON (after 3 attempts)'),
    ).toBeInTheDocument();
  });

  it("draws a running row's step progress as an image with the same words", () => {
    renderCard();
    const running = row('hooli.pdf');
    const label = 'Step 2 of 3 · line_items · chunk 2 of 2';
    expect(within(running).getByRole('img', { name: label })).toBeInTheDocument();
    expect(within(running).getByText(label)).toBeInTheDocument();
  });

  it('offers Retry on a failed run', async () => {
    const onRetry = vi.fn();
    renderCard(batch(), onRetry);
    await userEvent.click(
      within(row('stark.pdf')).getByRole('button', { name: 'Retry stark.pdf' }),
    );
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ filename: 'stark.pdf' }));
  });
});
