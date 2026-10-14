import { act, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JobLive, JobSummary } from '@ih/shared';
import { HomePage } from '../src/home/HomePage.js';
import { fakeApi, job, MODEL_CHOICES } from './fake-api.js';

function home(jobs: JobSummary[], me = 'ken', api = fakeApi()) {
  render(
    <HomePage
      api={api}
      me={me}
      jobs={jobs}
      error={null}
      refresh={vi.fn(async () => {})}
      pollMs={0}
      pickPending={false}
      onPicked={() => {}}
    />,
  );
  return api;
}

describe('HomePage model names while the choices load', () => {
  const mine = [job({ createdBy: 'ken', modelsUsed: ['local/qwen'], modelOverride: null })];
  const modelOf = async () => {
    const panel = await screen.findByRole('complementary', { name: 'Job details' });
    return within(panel).getByText('Model').nextElementSibling!;
  };

  it('shows a placeholder, not "Model no longer offered", until they are loaded', async () => {
    let resolve!: (c: typeof MODEL_CHOICES) => void;
    const listPickerChoices = vi.fn(() => new Promise<typeof MODEL_CHOICES>((r) => (resolve = r)));
    home(mine, 'ken', fakeApi({ listPickerChoices }));
    expect(await modelOf()).toHaveTextContent('…');
    expect(screen.queryByText('Model no longer offered')).toBeNull();
    resolve(MODEL_CHOICES);
    await waitFor(async () => expect(await modelOf()).toHaveTextContent('Main Production Model'));
  });

  it('shows a dash when they cannot be read, never the ref', async () => {
    home(
      mine,
      'ken',
      fakeApi({ listPickerChoices: vi.fn(async () => Promise.reject(new Error('down'))) }),
    );
    await waitFor(async () => expect(await modelOf()).toHaveTextContent('—'));
    expect(screen.queryByText(/local\/qwen/)).toBeNull();
    expect(screen.queryByText('Model no longer offered')).toBeNull();
  });
});

describe('HomePage', () => {
  it('has the upload strip and the latest job you queued, laid out wide', async () => {
    home([
      job({ filename: 'theirs.pdf', createdBy: 'ops', createdAt: '2026-10-13T10:05:00Z' }),
      job({ filename: 'mine-new.pdf', createdBy: 'ken', createdAt: '2026-10-13T10:00:00Z' }),
      job({ filename: 'mine-old.pdf', createdBy: 'ken', createdAt: '2026-10-13T09:00:00Z' }),
    ]);
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(screen.getByLabelText('PDF or Word files')).toBeInTheDocument();
    const panel = await screen.findByRole('complementary', { name: 'Job details' });
    expect(panel).toHaveClass('wide');
    expect(within(panel).getByRole('heading', { name: 'mine-new.pdf' })).toBeInTheDocument();
    expect(
      within(panel).getByRole('heading', { level: 3, name: 'Latest job' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'All jobs' })).toBeNull();
  });

  it('puts Upload documents before the latest job', async () => {
    home([job({ filename: 'a.pdf', createdBy: 'ken' })]);
    const upload = screen.getByRole('heading', { level: 2, name: 'Upload documents' });
    const latest = await screen.findByRole('heading', { level: 3, name: 'Latest job' });
    expect(upload.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const section = upload.closest('section')!;
    expect(within(section).getByLabelText('PDF or Word files')).toBeInTheDocument();
  });

  it('falls back to the newest job when you have queued none', async () => {
    home([
      job({ filename: 'older.pdf', createdBy: null, createdAt: '2026-10-13T09:00:00Z' }),
      job({ filename: 'newer.pdf', createdBy: null, createdAt: '2026-10-13T10:00:00Z' }),
    ]);
    const panel = await screen.findByRole('complementary', { name: 'Job details' });
    expect(within(panel).getByRole('heading', { name: 'newer.pdf' })).toBeInTheDocument();
  });

  it('invites an upload when there are no jobs', () => {
    home([]);
    expect(screen.getByText('No jobs yet: upload a document to start.')).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Job details' })).toBeNull();
  });
});

describe('HomePage live progress', () => {
  function live(
    jobs: JobSummary[],
    api: ReturnType<typeof fakeApi>,
    refresh = vi.fn(async () => {}),
  ) {
    render(
      <HomePage
        api={api}
        me="ken"
        jobs={jobs}
        error={null}
        refresh={refresh}
        pollMs={3000}
        livePollMs={10}
        pickPending={false}
        onPicked={() => {}}
      />,
    );
    return refresh;
  }

  it('follows a running job quickly, then refreshes the list once it finishes', async () => {
    const running = job({ id: 'j1', createdBy: 'ken', status: 'running', filename: 'a.pdf' });
    let calls = 0;
    const getJob = vi.fn(async () => {
      calls += 1;
      return calls < 3
        ? { ...running, outputs: [] }
        : {
            ...running,
            status: 'succeeded' as const,
            updatedAt: '2030-01-01T00:00:00Z',
            outputs: [],
          };
    });
    const api = fakeApi({ getJob });
    const refresh = live([running], api);
    const panel = await screen.findByRole('complementary', { name: 'Job details' });
    await waitFor(() => expect(within(panel).getAllByText('Succeeded').length).toBeGreaterThan(0));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // Step runs are re-read while it runs, so Extracting shows as soon as a step is recorded.
    expect(vi.mocked(api.getStepRuns).mock.calls.length).toBeGreaterThan(1);
  });

  it('does not poll a finished job', async () => {
    const done = job({ id: 'j2', createdBy: 'ken', status: 'succeeded' });
    const api = fakeApi();
    live([done], api);
    await screen.findByRole('complementary', { name: 'Job details' });
    await new Promise((r) => setTimeout(r, 60));
    // The panel's own load only.
    expect(vi.mocked(api.getJob).mock.calls.length).toBe(1);
  });

  it('says it is live while following a job', async () => {
    const api = fakeApi({ getJob: vi.fn(() => new Promise<never>(() => {})) });
    live([job({ createdBy: 'ken', status: 'queued' })], api);
    expect(await screen.findByText('Live · following this job')).toBeInTheDocument();
  });
});

describe('HomePage pushed progress', () => {
  type On = { update(live: JobLive): void; gone(): void; error(): void };
  function pushed(jobs: JobSummary[]) {
    let on!: On;
    const stop = vi.fn();
    const watchJob = vi.fn((_id: string, handlers: On) => {
      on = handlers;
      return stop;
    });
    const api = fakeApi({ watchJob });
    const refresh = vi.fn(async () => {});
    render(
      <HomePage
        api={api}
        me="ken"
        jobs={jobs}
        error={null}
        refresh={refresh}
        pollMs={3000}
        livePollMs={10}
        pickPending={false}
        onPicked={() => {}}
      />,
    );
    return { api, refresh, watchJob, stop, on: () => on };
  }
  const running = job({ id: 'j1', createdBy: 'ken', status: 'running', filename: 'a.pdf' });

  it('shows each pushed update, with where the run is, without polling', async () => {
    const r = pushed([running]);
    await waitFor(() => expect(r.watchJob).toHaveBeenCalledWith('j1', expect.anything()));
    const panel = await screen.findByRole('complementary', { name: 'Job details' });
    act(() =>
      r.on().update({ job: running, progress: { kind: 'prepare', stage: 'ocr', page: 3, of: 12 } }),
    );
    expect(await within(panel).findByText('OCR 3 of 12 pages')).toBeInTheDocument();
    act(() =>
      r.on().update({
        job: { ...running, updatedAt: '2030-01-01T00:00:00Z' },
        progress: { kind: 'step', step: 'head', index: 1, of: 2, attempt: 1, chunk: null },
      }),
    );
    expect(await within(panel).findByText('Step 1 of 2')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Only the panel's own loads (one per job change): no 10 ms poll.
    expect(vi.mocked(r.api.getJob).mock.calls.length).toBeLessThanOrEqual(2);
    act(() =>
      r.on().update({
        job: { ...running, status: 'succeeded', updatedAt: '2030-01-01T00:00:01Z' },
        progress: null,
      }),
    );
    await waitFor(() => expect(within(panel).getAllByText('Succeeded').length).toBeGreaterThan(0));
    expect(r.refresh).toHaveBeenCalled();
  });

  it('falls back to polling when the stream is unavailable', async () => {
    const r = pushed([running]);
    await waitFor(() => expect(r.watchJob).toHaveBeenCalled());
    act(() => r.on().error());
    await waitFor(() => expect(vi.mocked(r.api.getJob).mock.calls.length).toBeGreaterThan(2));
    expect(screen.getByText('Live · following this job')).toBeInTheDocument();
  });

  it('stops listening when the job is deleted, and reloads the list', async () => {
    const r = pushed([running]);
    await waitFor(() => expect(r.watchJob).toHaveBeenCalled());
    act(() => r.on().gone());
    await waitFor(() => expect(r.refresh).toHaveBeenCalled());
  });

  it('does not follow a finished job', async () => {
    const r = pushed([job({ createdBy: 'ken', status: 'succeeded' })]);
    await screen.findByRole('complementary', { name: 'Job details' });
    expect(r.watchJob).not.toHaveBeenCalled();
  });
});
