import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { EvaluationSet, IterationView } from '@ih/shared';
import type { Api } from '../src/api/client.js';
import { LatestRun, SEALED_NOTE } from '../src/workbench/EvaluateLatest.js';
import { fakeApi, feedbackItem, iterationView, MODEL_CHOICES } from './fake-api.js';

function latest(
  iteration: IterationView | null,
  overrides: Partial<Api> = {},
  set: EvaluationSet = iteration?.set ?? 'dev',
) {
  const api = fakeApi(overrides);
  render(
    <LatestRun
      api={api}
      projectId="letter"
      iteration={iteration}
      set={set}
      threshold={0.9}
      choices={MODEL_CHOICES}
    />,
  );
  return { api };
}
const row = (name: RegExp) => screen.getByRole('button', { name });

describe('LatestRun', () => {
  it('heads the run with its set, version, model, compared count and cache reuse', () => {
    latest(iterationView({ cache: { reused: 5, total: 8 } }));
    expect(
      screen.getByRole('heading', { name: "Latest dev run · v2 · recipe's models" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 of 2 compared · 5 of 8 steps reused from the cache/),
    ).toBeInTheDocument();
  });

  it('names the run by the model choice label, never a ref', () => {
    latest(iterationView({ model: 'cloud' }));
    expect(
      screen.getByRole('heading', { name: 'Latest dev run · v2 · Cloud model' }),
    ).toBeInTheDocument();
  });

  it('lists the samples as selectable rows with a score bar and what is off', () => {
    latest(iterationView());
    const a = row(/^a\.pdf/);
    expect(a).toHaveAttribute('aria-pressed', 'false');
    expect(within(a).getByText('50%')).toBeInTheDocument();
    expect(within(a).getByText('Off: sent_on')).toBeInTheDocument();
    expect(within(a).getByLabelText('a.pdf score: 50%, threshold 90%')).toBeInTheDocument();
    expect(within(row(/^b\.pdf/)).getByText('All match')).toBeInTheDocument();
  });

  it('opens the comparison table for the selected sample, and closes it again', async () => {
    latest(iterationView());
    await userEvent.click(row(/^a\.pdf/));
    expect(row(/^a\.pdf/)).toHaveAttribute('aria-pressed', 'true');
    const table = screen.getByRole('table', { name: 'Outputs in a.pdf' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Output', 'Reference', 'This run', 'Match', 'Comment']);
    const sentOn = within(table).getByText('sent_on').closest('tr')!;
    expect(sentOn).toHaveTextContent('2026-03-01');
    expect(sentOn).toHaveTextContent('2026-01-03');
    expect(within(sentOn).getByRole('img', { name: 'differs' })).toBeInTheDocument();
    expect(within(sentOn).getByRole('button', { name: 'Comment' })).toBeInTheDocument();
    const sender = within(table).getByText('sender').closest('tr')!;
    expect(within(sender).getByRole('img', { name: 'matches' })).toBeInTheDocument();
    expect(within(sender).queryByRole('button', { name: 'Comment' })).toBeNull();
    expect(screen.getByText(/1 of 2 outputs differ from the reference/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Review' })).toHaveAttribute(
      'href',
      '#/review/j1',
    );
    await userEvent.click(row(/^a\.pdf/));
    expect(screen.queryByRole('table', { name: 'Outputs in a.pdf' })).toBeNull();
  });

  it('saves a comment on a dev mismatch for Revise', async () => {
    const it0 = iterationView();
    const { api } = latest(it0, { addFeedback: vi.fn(async () => feedbackItem()) });
    await userEvent.click(row(/^a\.pdf/));
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const save = screen.getByRole('button', { name: 'Save comment' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'Write a comment first');
    const box = screen.getByLabelText(/^Comment on sent_on/);
    expect(box).toHaveAttribute('maxlength', '2000');
    await userEvent.type(box, 'Dates are DMY');
    await userEvent.click(save);
    expect(api.addFeedback).toHaveBeenCalledWith('letter', {
      target: 'field',
      targetId: 'sent_on',
      body: 'Dates are DMY',
      sampleId: 's1',
      iterationId: it0.id,
    });
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Comment saved — see Revise');
    expect(within(status).getByRole('link', { name: 'Revise' })).toHaveAttribute(
      'href',
      '#/workbench/letter/revise',
    );
  });

  it('keeps a comment that failed to save and shows why', async () => {
    latest(iterationView(), {
      addFeedback: vi.fn(async () =>
        Promise.reject(new Error('feedback can only refer to dev samples')),
      ),
    });
    await userEvent.click(row(/^a\.pdf/));
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await userEvent.type(screen.getByLabelText(/^Comment on sent_on/), 'Dates are DMY');
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'feedback can only refer to dev samples',
    );
    expect(screen.getByLabelText(/^Comment on sent_on/)).toHaveValue('Dates are DMY');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('comments on a table that differs', async () => {
    const base = iterationView();
    const it0 = iterationView({
      samples: [
        {
          ...base.samples[0]!,
          comparison: {
            score: 0.5,
            fields: [],
            tables: [
              {
                id: 'lines',
                expected: 2,
                actual: 1,
                matched: 1,
                missing: [{ qty: 1 }],
                extra: [],
                changed: [],
                cells: 1,
                cellsTotal: 2,
                columns: { qty: { matched: 1, total: 2 } },
              },
            ],
          },
        },
      ],
    });
    const { api } = latest(it0, { addFeedback: vi.fn(async () => feedbackItem()) });
    await userEvent.click(row(/^a\.pdf/));
    const lines = screen.getByText('lines').closest('tr')!;
    expect(lines).toHaveTextContent('2 rows');
    expect(lines).toHaveTextContent('1 row · 1 missing');
    await userEvent.click(within(lines).getByRole('button', { name: 'Comment' }));
    await userEvent.type(screen.getByLabelText(/^Comment on lines/), 'Rows run onto page 3');
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    expect(api.addFeedback).toHaveBeenCalledWith(
      'letter',
      expect.objectContaining({ target: 'table', targetId: 'lines' }),
    );
  });

  it('keeps holdout sealed: differences are shown, comments are not', async () => {
    latest(iterationView({ set: 'holdout' }));
    expect(screen.getByRole('heading', { name: /^Latest holdout run/ })).toBeInTheDocument();
    await userEvent.click(row(/^a\.pdf/));
    expect(screen.getByText(SEALED_NOTE)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Outputs in a.pdf' });
    expect(within(table).queryByRole('button', { name: 'Comment' })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: 'Comment' })).toBeNull();
  });

  it('cannot select a sample that was not compared, and says why', () => {
    const base = iterationView();
    latest(
      iterationView({
        samples: [
          ...base.samples,
          {
            sampleId: 's3',
            filename: 'c.pdf',
            jobId: 'j3',
            status: 'needs_review',
            error: null,
            comparison: null,
          },
        ],
      }),
    );
    const c = row(/^c\.pdf/);
    expect(c).toBeDisabled();
    expect(c).toHaveAttribute('title', 'Not compared: needs review');
    expect(c).toHaveTextContent('needs review');
  });

  it('says when the set has no run yet', () => {
    latest(null, {}, 'holdout');
    expect(
      screen.getByText(
        'No holdout run yet. Holdout runs need verified holdout references (References tab) and are optional.',
      ),
    ).toBeInTheDocument();
  });
});
