import type { JobOutput, JobSummary, StepRun } from '@ih/shared';
import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JobDetailPanel } from '../src/jobs/JobDetailPanel.js';
import { fakeApi, job, MODEL_CHOICES } from './fake-api.js';

const run = (o: Partial<StepRun> = {}): StepRun => ({
  id: 1,
  stepId: 'header',
  trigger: 'process',
  model: 'local/m',
  attempts: 1,
  inputTokens: 1,
  outputTokens: 1,
  status: 'succeeded',
  cached: false,
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
  targetId: null,
});

const defaults = {
  onChanged: vi.fn(),
  models: [],
  specTitles: new Map<string, string>(),
  now: Date.parse('2026-10-12T12:00:00Z'),
};

const panel = () => screen.getByRole('complementary', { name: 'Job details' });

describe('JobDetailPanel', () => {
  it('shows the model by its choice label, plain, with no ref anywhere', async () => {
    const j = job({ id: 'm', modelsUsed: ['local/qwen'], modelOverride: null });
    render(<JobDetailPanel api={fakeApi()} job={j} {...defaults} models={MODEL_CHOICES} />);
    const dd = within(panel()).getByText('Main Production Model');
    expect(dd).not.toHaveClass('mono');
    expect(dd).not.toHaveAttribute('title');
    expect(panel().innerHTML).not.toContain('local/qwen');
    await act(async () => {});
  });

  it('shows the reviewer callout, progress and meta, and no downloads of draft outputs', async () => {
    const j = job({
      id: 'a',
      filename: 'inv.pdf',
      status: 'awaiting_review',
      reviewReasons: ['Total off', 'Row 4 amount'],
      specId: 'inv',
      specVersion: 3,
      attempts: 1,
    });
    const getJob = vi.fn(async () => ({ ...j, outputs: [output({})] }));
    const api = fakeApi({ getJob, getStepRuns: vi.fn(async () => [run()]) });
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
    await vi.waitFor(() => expect(getJob).toHaveBeenCalled());
    await act(async () => {}); // let the loaded outputs render
    // Drafts are not deliverables: only published outputs are offered for download.
    expect(within(panel()).queryByRole('region', { name: /outputs/i })).not.toBeInTheDocument();
    expect(within(panel()).queryByRole('link', { name: /download/i })).not.toBeInTheDocument();
    expect(within(panel()).queryByText('line_items.csv')).not.toBeInTheDocument();
    expect(within(panel()).getByRole('link', { name: 'Review & approve' })).toHaveAttribute(
      'href',
      '#/review/a',
    );
    expect(within(panel()).getByRole('link', { name: 'Open PDF' })).toHaveAttribute(
      'href',
      '/api/jobs/a/document',
    );
  });

  it('offers every published output as one ZIP download', async () => {
    const j = job({ id: 'a', filename: 'inv.pdf', status: 'succeeded' });
    const api = fakeApi({
      getJob: vi.fn(async () => ({
        ...j,
        outputs: [
          output({}),
          output({ stage: 'published', key: 'pub/line_items.csv' }),
          output({ stage: 'published', outputId: 'totals', key: 'pub/totals.csv' }),
          output({
            stage: 'published',
            outputId: 'doc',
            format: 'json',
            key: 'pub/doc.json',
            rowCount: null,
            targetId: 'default',
          }),
          output({ outputId: 'doc', format: 'json', key: 'x/doc.json', rowCount: null }),
        ],
      })),
    });
    render(<JobDetailPanel api={api} job={j} {...defaults} />);
    const section = await within(panel()).findByRole('region', { name: 'Published outputs' });
    const links = within(section).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('Download inv.pdf outputs as ZIP');
    expect(links[0]).toHaveAttribute('href', '/api/results/a/archive');
    expect(links[0]).toHaveTextContent('Download outputs (ZIP)');
    expect(within(section).getByText('3 files: 2 CSV, 1 JSON')).toBeInTheDocument();
    expect(within(panel()).queryByText('line_items.csv')).not.toBeInTheDocument();
  });

  describe('wide (Home)', () => {
    const headings = () =>
      within(panel())
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent);

    it('has Latest job, Progress, Status and actions and Details, each a labelled section', async () => {
      const j = job({ id: 'w', filename: 'inv.pdf', status: 'awaiting_review' });
      render(<JobDetailPanel api={fakeApi()} job={j} {...defaults} wide />);
      expect(headings()).toEqual(['Latest job', 'Progress', 'Status and actions', 'Details']);
      for (const name of ['Progress', 'Status and actions', 'Details']) {
        expect(within(panel()).getByRole('region', { name })).toBeInTheDocument();
      }
      expect(within(panel()).getByRole('heading', { level: 2, name: 'inv.pdf' })).toBeVisible();
      await act(async () => {});
    });

    it('renders the five progress steps with their state text', async () => {
      const j = job({ id: 'w', status: 'awaiting_review' });
      render(<JobDetailPanel api={fakeApi()} job={j} {...defaults} wide />);
      const steps = within(within(panel()).getByRole('list', { name: 'Progress' })).getAllByRole(
        'listitem',
      );
      expect(steps).toHaveLength(5);
      for (const step of steps) {
        expect(step.querySelector('.step-label')?.textContent).toBeTruthy();
        expect(step.querySelector('.step-state')?.textContent).toBeTruthy();
      }
      await act(async () => {});
    });

    it('lists Published outputs only when something was published', async () => {
      const j = job({ id: 'w', filename: 'inv.pdf', status: 'succeeded' });
      const none = fakeApi({ getJob: vi.fn(async () => ({ ...j, outputs: [output({})] })) });
      const { unmount } = render(<JobDetailPanel api={none} job={j} {...defaults} wide />);
      await act(async () => {});
      expect(headings()).not.toContain('Published outputs');
      unmount();
      const some = fakeApi({
        getJob: vi.fn(async () => ({ ...j, outputs: [output({ stage: 'published' })] })),
      });
      render(<JobDetailPanel api={some} job={j} {...defaults} wide />);
      expect(
        await within(panel()).findByRole('heading', { name: 'Published outputs' }),
      ).toBeVisible();
    });
  });

  it('keeps the side panel as it was: Job details label, no Details section', async () => {
    const j = job({ id: 'n', status: 'succeeded' });
    render(<JobDetailPanel api={fakeApi()} job={j} {...defaults} />);
    expect(within(panel()).getByText('Job details')).toBeInTheDocument();
    expect(within(panel()).queryByRole('heading', { name: 'Details' })).toBeNull();
    await act(async () => {});
  });

  it('says "1 file" for a single published output', async () => {
    const j = job({ id: 'a', filename: 'inv.pdf', status: 'succeeded' });
    const api = fakeApi({
      getJob: vi.fn(async () => ({
        ...j,
        outputs: [output({ stage: 'published', format: 'json', rowCount: null })],
      })),
    });
    render(<JobDetailPanel api={api} job={j} {...defaults} />);
    expect(await within(panel()).findByText('1 file: 1 JSON')).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Retry gone.pdf' })).toBeInTheDocument();
  });
});

describe('JobDetailPanel step times', () => {
  const at = (s: number) => new Date(Date.parse('2026-10-12T10:00:00Z') + s * 1000).toISOString();
  const done = job({
    id: 't',
    status: 'succeeded',
    startedAt: at(0),
    finishedAt: at(100),
    updatedAt: at(100),
  });

  it('puts the time each step took under its status, with a clock', async () => {
    const api = fakeApi({
      getJob: vi.fn(async () => ({
        ...done,
        outputs: [],
        stageTimes: { readAt: at(20), segmentedAt: at(25) },
      })),
      getStepRuns: vi.fn(async () => [run({ startedAt: at(30), finishedAt: at(90) })]),
    });
    render(<JobDetailPanel api={api} job={done} {...defaults} wide />);
    const steps = await within(panel()).findAllByRole('listitem');
    const progress = within(panel()).getByRole('list', { name: 'Progress' });
    await within(progress).findByText('00:20');
    const times = within(progress)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.step-time')?.textContent ?? null);
    expect(times).toEqual([
      'Time taken 00:20',
      'Time taken 00:05',
      'Time taken 01:05',
      'Time taken 00:10',
      'Time taken 00:00',
    ]);
    const clock = progress.querySelector('.step-time svg');
    expect(clock).toHaveAttribute('aria-hidden', 'true');
    expect(steps.length).toBeGreaterThan(0);
  });

  it('shows no time for a step that has not run or was never timed', async () => {
    const queued = job({ id: 'q', status: 'queued' });
    render(<JobDetailPanel api={fakeApi()} job={queued} {...defaults} wide />);
    await act(async () => {});
    expect(panel().querySelector('.step-time')).toBeNull();
  });

  it('takes the times Home pushes over the ones it loaded', async () => {
    const running = job({ id: 'r', status: 'running', startedAt: at(0), finishedAt: null });
    render(
      <JobDetailPanel
        api={fakeApi()}
        job={running}
        {...defaults}
        now={Date.parse(at(60))}
        wide
        progress={{
          kind: 'step',
          step: 'a',
          index: 1,
          of: 2,
          attempt: 1,
          chunk: null,
          occurrence: null,
        }}
        stageTimes={{ readAt: at(20), segmentedAt: at(25) }}
      />,
    );
    const progress = within(panel()).getByRole('list', { name: 'Progress' });
    expect(await within(progress).findByText('00:20')).toBeInTheDocument();
    expect(within(progress).getByText('00:05')).toBeInTheDocument();
  });
});

describe('JobDetailPanel graph (ADR 0011 step 6)', () => {
  const published = job({ id: 'j9', status: 'succeeded' });
  const detail = (graph: unknown) =>
    fakeApi({
      getJob: vi.fn(async () => ({ ...published, outputs: [], graph }) as never),
      getStepRuns: vi.fn(async () => []),
    });

  it('names the published graph, its version and where it went', async () => {
    const graph = {
      iri: 'https://data.acme.example/graph/source/ab/demo',
      version: 2,
      triples: 42,
      endpoint: true,
      publishedAt: '2026-10-12T11:00:00Z',
    };
    render(<JobDetailPanel api={detail(graph)} job={published} {...defaults} />);
    expect(await within(panel()).findByText('Graph')).toBeInTheDocument();
    expect(panel()).toHaveTextContent('Version 2 · 42 triples · in the triple store');
    expect(panel()).toHaveTextContent('https://data.acme.example/graph/source/ab/demo');
  });

  it('says when the graph went to S3 only, and shows nothing without one', async () => {
    const s3 = {
      iri: 'https://data.acme.example/graph/source/ab/demo',
      version: 1,
      triples: 1,
      endpoint: false,
      publishedAt: '2026-10-12T11:00:00Z',
    };
    const { unmount } = render(<JobDetailPanel api={detail(s3)} job={published} {...defaults} />);
    expect(await within(panel()).findByText(/S3 only/)).toBeInTheDocument();
    expect(panel()).toHaveTextContent('Version 1 · 1 triple · S3 only');
    unmount();
    render(<JobDetailPanel api={detail(null)} job={published} {...defaults} />);
    await within(panel()).findByText('Document type');
    expect(within(panel()).queryByText('Graph')).toBeNull();
  });
});
