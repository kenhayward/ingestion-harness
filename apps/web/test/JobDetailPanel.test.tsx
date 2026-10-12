import type { JobOutput, JobSummary, StepRun } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JobDetailPanel } from '../src/jobs/JobDetailPanel.js';
import { fakeApi, job } from './fake-api.js';

const run = (o: Partial<StepRun> = {}): StepRun => ({
  id: 1,
  stepId: 'header',
  trigger: 'process',
  model: 'local/m',
  attempts: 1,
  inputTokens: 1,
  outputTokens: 1,
  status: 'succeeded',
  error: null,
  startedAt: '2026-10-12T10:00:00Z',
  finishedAt: '2026-10-12T10:00:05Z',
  ...o,
});

const output = (o: Partial<JobOutput>): JobOutput => ({
  outputId: 'line_items',
  stage: 'draft',
  format: 'csv',
  bucket: 'b',
  key: 'x/line_items.csv',
  rowCount: 14,
  ...o,
});

const defaults = {
  onChanged: vi.fn(),
  retryModel: '',
  models: [],
  specTitles: new Map<string, string>(),
  now: Date.parse('2026-10-12T12:00:00Z'),
};

const panel = () => screen.getByRole('complementary', { name: 'Job details' });

describe('JobDetailPanel', () => {
  it('shows the reviewer callout, progress, meta and draft outputs for a job awaiting review', async () => {
    const j = job({
      id: 'a',
      filename: 'inv.pdf',
      status: 'awaiting_review',
      reviewReasons: ['Total off', 'Row 4 amount'],
      specId: 'inv',
      specVersion: 3,
      attempts: 1,
    });
    const api = fakeApi({
      getJob: vi.fn(async () => ({ ...j, outputs: [output({})] })),
      getStepRuns: vi.fn(async () => [run()]),
    });
    render(
      <JobDetailPanel
        api={api}
        job={j}
        {...defaults}
        specTitles={new Map([['inv', 'Supplier invoice']])}
      />,
    );
    expect(within(panel()).getByRole('heading', { name: 'inv.pdf' })).toBeInTheDocument();
    const note = within(panel()).getByRole('note');
    expect(note).toHaveTextContent('Needs a reviewer');
    expect(note).toHaveTextContent('Total off');
    expect(note).toHaveTextContent('Row 4 amount');
    const progress = within(panel()).getByRole('list', { name: 'Progress' });
    expect(within(progress).getAllByRole('listitem')).toHaveLength(5);
    expect(within(progress).getByText('Waiting for you')).toBeInTheDocument();
    expect(within(panel()).getByText('Supplier invoice v3')).toBeInTheDocument();
    expect(await within(panel()).findByText('Draft outputs')).toBeInTheDocument();
    expect(within(panel()).getByRole('link', { name: /line_items\.csv/ })).toHaveAttribute(
      'href',
      '/api/jobs/a/outputs/line_items?stage=draft',
    );
    expect(within(panel()).getByText('14 rows')).toBeInTheDocument();
    expect(within(panel()).getByRole('link', { name: 'Review & approve' })).toHaveAttribute(
      'href',
      '#/review/a',
    );
    expect(within(panel()).getByRole('link', { name: 'Open PDF' })).toHaveAttribute(
      'href',
      '/api/jobs/a/document',
    );
  });

  it('prefers published outputs once published', async () => {
    const j = job({ id: 'a', filename: 'inv.pdf', status: 'succeeded' });
    const api = fakeApi({
      getJob: vi.fn(async () => ({
        ...j,
        outputs: [
          output({}),
          output({ stage: 'published', key: 'pub/line_items.csv' }),
          output({ outputId: 'doc', format: 'json', key: 'x/doc.json', rowCount: null }),
        ],
      })),
    });
    render(<JobDetailPanel api={api} job={j} {...defaults} />);
    expect(await within(panel()).findByText('Published outputs')).toBeInTheDocument();
    const links = within(panel()).getAllByRole('link', { name: /\.csv|\.json/ });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/api/jobs/a/outputs/line_items?stage=published',
    ]);
  });

  it('reloads when the job changes status', async () => {
    const j = job({ id: 'a', filename: 'inv.pdf', status: 'running' });
    const getStepRuns = vi.fn(async () => [] as StepRun[]);
    const api = fakeApi({ getStepRuns });
    const { rerender } = render(<JobDetailPanel api={api} job={j} {...defaults} />);
    await vi.waitFor(() => expect(getStepRuns).toHaveBeenCalledTimes(1));
    rerender(
      <JobDetailPanel
        api={api}
        job={{ ...j, status: 'awaiting_review' } as JobSummary}
        {...defaults}
      />,
    );
    await vi.waitFor(() => expect(getStepRuns).toHaveBeenCalledTimes(2));
  });

  it('still renders when details fail to load', async () => {
    const j = job({ id: 'a', filename: 'gone.pdf', status: 'failed', error: 'boom' });
    const api = fakeApi({
      getJob: vi.fn(async () => {
        throw new Error('404 Not Found');
      }),
      getStepRuns: vi.fn(async () => {
        throw new Error('404 Not Found');
      }),
    });
    render(<JobDetailPanel api={api} job={j} {...defaults} />);
    expect(await screen.findByText(/Couldn't load details: 404/)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: 'Retry with spec default' })).toBeInTheDocument();
  });
});
