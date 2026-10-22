import type { JobSummary } from '@ih/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_PAGE_SIZE, JobsPage } from '../src/jobs/JobsPage.js';
import { fakeApi, job } from './fake-api.js';

type Props = ComponentProps<typeof JobsPage>;
const element = (jobs: JobSummary[], o: Partial<Props> = {}) => (
  <JobsPage
    api={fakeApi()}
    jobs={jobs}
    error={null}
    refresh={vi.fn(async () => {})}
    query=""
    pollMs={0}
    {...o}
  />
);
const page = (jobs: JobSummary[], o: Partial<Props> = {}) => render(element(jobs, o));
const panel = () => screen.getByRole('complementary', { name: 'Job details' });

describe('JobsPage', () => {
  it('has a header and filters by status chip with counts', async () => {
    page([
      job({ filename: 'a.pdf', status: 'failed' }),
      job({ filename: 'b.pdf', status: 'running' }),
      job({ filename: 'c.pdf', status: 'succeeded' }),
    ]);
    expect(screen.getByRole('heading', { level: 1, name: 'Jobs' })).toBeInTheDocument();
    // Uploading moved to Home: Jobs is the list and the detail panel.
    expect(screen.queryByLabelText('PDF or Word files')).toBeNull();
    const chips = screen.getByRole('group', { name: 'Filter jobs by status' });
    expect(within(chips).getByRole('button', { name: 'All 3' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(chips).getByRole('button', { name: 'In progress 1' })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: 'Finished 1' })).toBeInTheDocument();
    await userEvent.click(within(chips).getByRole('button', { name: 'Needs attention 1' }));
    const list = screen.getByRole('region', { name: 'Job list' });
    expect(within(list).getByText('a.pdf')).toBeInTheDocument();
    expect(within(list).queryByText('b.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 3 jobs')).toBeInTheDocument();
  });

  it('selects the first job needing attention by default and follows clicks', async () => {
    page([
      job({ id: 'b', filename: 'b.pdf', status: 'succeeded' }),
      job({ id: 'a', filename: 'a.pdf', status: 'awaiting_review' }),
    ]);
    expect(within(panel()).getByRole('heading', { name: 'a.pdf' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show details for b.pdf' }));
    expect(within(panel()).getByRole('heading', { name: 'b.pdf' })).toBeInTheDocument();
  });

  it('falls back when the selected job disappears', async () => {
    const a = job({ id: 'a', filename: 'a.pdf', status: 'failed' });
    const b = job({ id: 'b', filename: 'b.pdf', status: 'succeeded' });
    const { rerender } = page([a, b]);
    await userEvent.click(screen.getByRole('button', { name: 'Show details for b.pdf' }));
    rerender(element([a]));
    expect(within(panel()).getByRole('heading', { name: 'a.pdf' })).toBeInTheDocument();
  });

  it('keeps the shown job (and an open retry dialog) when a poll brings a newer job needing attention', async () => {
    const a = job({ id: 'a', filename: 'a.pdf', status: 'failed' });
    const { rerender } = page([a]);
    await userEvent.click(within(panel()).getByRole('button', { name: 'Retry a.pdf' }));
    const b = job({ id: 'b', filename: 'b.pdf', status: 'failed' });
    rerender(element([b, a]));
    expect(within(panel()).getByRole('heading', { name: 'a.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Retry a.pdf' })).toBeInTheDocument();
  });

  it('falls back when a chip hides the selected job, and says when a view is empty', async () => {
    page([job({ id: 'a', filename: 'a.pdf', status: 'succeeded' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Needs attention 0' }));
    expect(screen.queryByRole('complementary', { name: 'Job details' })).not.toBeInTheDocument();
    expect(screen.getByText('No jobs in this view.')).toBeInTheDocument();
  });

  it('says when the search matches nothing', () => {
    page([job({ filename: 'a.pdf' })], { query: 'globex' });
    expect(screen.getByText('No jobs match “globex”.')).toBeInTheDocument();
  });

  it('shows Live, or Reconnecting when the poll fails', () => {
    const { rerender } = page([], { pollMs: 3000 });
    expect(screen.getByText('Live · refreshes every 3 s')).toBeInTheDocument();
    rerender(element([], { pollMs: 3000, error: '503 Service Unavailable' }));
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('503');
  });

  it('opens the clean-up controls from the footer', async () => {
    page([job({ status: 'succeeded' })]);
    const toggle = screen.getByRole('button', { name: 'Clean up finished jobs…' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Clean up old jobs' })).toBeInTheDocument();
  });

  it('names document types from the spec list', async () => {
    const api = fakeApi({
      listSpecs: vi.fn(async () => [{ id: 'inv', version: 3, title: 'Supplier invoice' }]),
    });
    page([job({ filename: 'a.pdf', specId: 'inv', specVersion: 3 })], { api });
    const list = screen.getByRole('region', { name: 'Job list' });
    expect(await within(list).findByText('Supplier invoice v3')).toBeInTheDocument();
  });

  it('asks for retired document types too, so old jobs keep their names', async () => {
    const api = fakeApi({
      listSpecs: vi.fn(async () => [
        {
          id: 'inv',
          version: 3,
          title: 'Supplier invoice',
          retired: { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' },
        },
      ]),
    });
    page([job({ filename: 'a.pdf', specId: 'inv', specVersion: 3 })], { api });
    const list = screen.getByRole('region', { name: 'Job list' });
    expect(await within(list).findByText('Supplier invoice v3')).toBeInTheDocument();
    expect(api.listSpecs).toHaveBeenCalledWith({ retired: 'include' });
  });
});

describe('JobsPage: My jobs', () => {
  afterEach(() => localStorage.clear());

  it('shows only my jobs, fetched from the server, with the status chips still applying', async () => {
    const listJobs = vi.fn(async () => [
      job({ filename: 'mine-failed.pdf', status: 'failed', createdBy: 'ken' }),
      job({ filename: 'mine-done.pdf', status: 'succeeded', createdBy: 'ken' }),
    ]);
    page(
      [
        job({ filename: 'mine-failed.pdf', status: 'failed', createdBy: 'ken' }),
        job({ filename: 'theirs.pdf', status: 'failed', createdBy: 'ops' }),
      ],
      { api: fakeApi({ listJobs }) },
    );
    const toggle = screen.getByRole('button', { name: 'My jobs' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(listJobs).not.toHaveBeenCalled();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(listJobs).toHaveBeenCalledWith({ mine: true });
    const list = screen.getByRole('region', { name: 'Job list' });
    expect(await within(list).findByText('mine-done.pdf')).toBeInTheDocument();
    expect(within(list).queryByText('theirs.pdf')).not.toBeInTheDocument();
    const chips = screen.getByRole('group', { name: 'Filter jobs by status' });
    expect(within(chips).getByRole('button', { name: 'All 2' })).toBeInTheDocument();
    await userEvent.click(within(chips).getByRole('button', { name: 'Needs attention 1' }));
    expect(within(list).getByText('mine-failed.pdf')).toBeInTheDocument();
    expect(within(list).queryByText('mine-done.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 2 jobs')).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(within(list).getByText('theirs.pdf')).toBeInTheDocument();
  });

  it('says when none of the jobs are mine', async () => {
    page([job({ filename: 'theirs.pdf' })], {
      api: fakeApi({ listJobs: vi.fn(async () => []) }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'My jobs' }));
    expect(await screen.findByText('You have not queued any jobs yet.')).toBeInTheDocument();
  });

  it('remembers the toggle', async () => {
    const listJobs = vi.fn(async () => [job({ filename: 'mine.pdf', createdBy: 'ken' })]);
    const { unmount } = page([job({ filename: 'theirs.pdf' })], { api: fakeApi({ listJobs }) });
    await userEvent.click(screen.getByRole('button', { name: 'My jobs' }));
    unmount();
    page([job({ filename: 'theirs.pdf' })], { api: fakeApi({ listJobs }) });
    expect(screen.getByRole('button', { name: 'My jobs' })).toHaveAttribute('aria-pressed', 'true');
    expect(
      await within(screen.getByRole('region', { name: 'Job list' })).findByText('mine.pdf'),
    ).toBeInTheDocument();
  });

  it('refreshes my jobs, and the shared list, after an action', async () => {
    const mine = job({ filename: 'mine.pdf', status: 'failed', createdBy: 'ken' });
    const listJobs = vi.fn(async () => [mine]);
    const refresh = vi.fn(async () => {});
    page([], { api: fakeApi({ listJobs }), refresh });
    await userEvent.click(screen.getByRole('button', { name: 'My jobs' }));
    await screen.findAllByText('mine.pdf');
    expect(listJobs).toHaveBeenCalledTimes(1);
    await userEvent.click(within(panel()).getByRole('button', { name: 'Retry mine.pdf' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }),
    );
    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalled();
  });

  it('shows who queued the selected job', () => {
    page([job({ filename: 'a.pdf', createdBy: 'ken' })]);
    expect(within(panel()).getByText('Queued by')).toBeInTheDocument();
    expect(within(panel()).getByText('ken')).toBeInTheDocument();
  });

  it('leaves out Queued by for jobs from before it was recorded', () => {
    page([job({ filename: 'a.pdf', createdBy: null })]);
    expect(within(panel()).queryByText('Queued by')).not.toBeInTheDocument();
  });
});

describe('JobsPage: a linked job (#/jobs/<id>)', () => {
  it('opens the linked job rather than the first one needing attention', () => {
    page(
      [
        job({ id: 'a', filename: 'a.pdf', status: 'failed' }),
        job({ id: 'b', filename: 'b.pdf', status: 'succeeded' }),
      ],
      { jobId: 'b' },
    );
    expect(within(panel()).getByRole('heading', { name: 'b.pdf' })).toBeInTheDocument();
  });

  it('follows a new link while the page is open', () => {
    const jobs = [
      job({ id: 'a', filename: 'a.pdf', status: 'failed' }),
      job({ id: 'b', filename: 'b.pdf', status: 'succeeded' }),
    ];
    const { rerender } = page(jobs, { jobId: 'b' });
    rerender(element(jobs, { jobId: 'a' }));
    expect(within(panel()).getByRole('heading', { name: 'a.pdf' })).toBeInTheDocument();
  });

  it('says when the linked job is not in the list', () => {
    page([job({ id: 'a', filename: 'a.pdf', status: 'failed' })], { jobId: 'gone' });
    expect(screen.getByRole('status', { name: 'Linked job' })).toHaveTextContent(
      'The linked job is not in this list: it may have been deleted, or be older than the list shows.',
    );
  });
});

describe('JobsPage help', () => {
  it('explains the Jobs page from the page header', async () => {
    page([]);
    const header = screen.getByRole('heading', { level: 1, name: 'Jobs' }).closest('.page-header')!;
    await userEvent.click(
      within(header as HTMLElement).getByRole('button', { name: 'Help: Using the Jobs page' }),
    );
    expect(screen.getByRole('dialog', { name: 'Using the Jobs page' })).toBeInTheDocument();
  });
});

/** `n` jobs, newest first, named job-01.pdf …; the first needs attention so it is selected. */
const many = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    job({
      id: `j${i + 1}`,
      filename: `job-${String(i + 1).padStart(2, '0')}.pdf`,
      status: i === 0 ? 'failed' : 'succeeded',
    }),
  );
const listRegion = () => screen.getByRole('region', { name: 'Job list' });
const shown = () =>
  within(listRegion())
    .getAllByRole('button', { name: /^Show details for / })
    .map((b) => b.textContent);
const pager = () => screen.getByRole('navigation', { name: 'Pages of jobs' });

describe('JobsPage pages', () => {
  it('shows a page of jobs at a time, paged from the top of the list', async () => {
    expect(FALLBACK_PAGE_SIZE).toBe(25);
    page(many(30));
    expect(shown()).toHaveLength(25);
    expect(shown()[0]).toBe('job-01.pdf');
    expect(pager()).toHaveTextContent('1–25 of 30');
    expect(pager()).toHaveTextContent('Page 1 of 2');
    expect(within(pager()).getByRole('button', { name: 'Newer jobs' })).toBeDisabled();
    await userEvent.click(within(pager()).getByRole('button', { name: 'Older jobs' }));
    expect(shown()).toEqual(['job-26.pdf', 'job-27.pdf', 'job-28.pdf', 'job-29.pdf', 'job-30.pdf']);
    expect(pager()).toHaveTextContent('26–30 of 30');
    expect(pager()).toHaveTextContent('Page 2 of 2');
    expect(within(pager()).getByRole('button', { name: 'Older jobs' })).toBeDisabled();
    // Paging leaves the selected job in the panel.
    expect(within(panel()).getByRole('heading', { name: 'job-01.pdf' })).toBeInTheDocument();
  });

  it('goes back to the first page when the status filter changes', async () => {
    page(many(30));
    await userEvent.click(within(pager()).getByRole('button', { name: 'Older jobs' }));
    await userEvent.click(screen.getByRole('button', { name: 'Finished 29' }));
    expect(pager()).toHaveTextContent('Page 1 of 2');
    expect(shown()[0]).toBe('job-02.pdf');
  });

  it('keeps a page to show when the list shrinks under it', async () => {
    const jobs = many(30);
    const { rerender } = page(jobs);
    await userEvent.click(within(pager()).getByRole('button', { name: 'Older jobs' }));
    rerender(element(jobs.slice(0, 20)));
    expect(pager()).toHaveTextContent('Page 1 of 1');
    expect(shown()).toHaveLength(20);
  });

  it("opens on a linked job's page", () => {
    page(many(30), { jobId: 'j28' });
    expect(pager()).toHaveTextContent('Page 2 of 2');
    expect(within(panel()).getByRole('heading', { name: 'job-28.pdf' })).toBeInTheDocument();
  });
});

describe('JobsPage keyboard', () => {
  it('moves the selection with ↑ and ↓, across pages', async () => {
    page(many(30));
    within(listRegion()).getByRole('button', { name: 'Show details for job-24.pdf' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(within(panel()).getByRole('heading', { name: 'job-25.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show details for job-25.pdf' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(pager()).toHaveTextContent('Page 2 of 2');
    expect(screen.getByRole('button', { name: 'Show details for job-26.pdf' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(pager()).toHaveTextContent('Page 1 of 2');
    expect(within(panel()).getByRole('heading', { name: 'job-25.pdf' })).toBeInTheDocument();
  });

  it('pages with Page Down and Page Up, selecting the first job of the page', async () => {
    page(many(30));
    within(listRegion()).getByRole('button', { name: 'Show details for job-03.pdf' }).focus();
    await userEvent.keyboard('{PageDown}');
    expect(pager()).toHaveTextContent('Page 2 of 2');
    expect(screen.getByRole('button', { name: 'Show details for job-26.pdf' })).toHaveFocus();
    expect(within(panel()).getByRole('heading', { name: 'job-26.pdf' })).toBeInTheDocument();
    await userEvent.keyboard('{PageUp}');
    expect(screen.getByRole('button', { name: 'Show details for job-01.pdf' })).toHaveFocus();
  });

  it('opens the selected job with Enter when it can be reviewed or viewed', async () => {
    page([
      job({ id: 'a', filename: 'a.pdf', status: 'awaiting_review' }),
      job({ id: 'b', filename: 'b.pdf', status: 'failed' }),
    ]);
    window.location.hash = '#/jobs';
    screen.getByRole('button', { name: 'Show details for a.pdf' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/review/a');
    window.location.hash = '#/jobs';
    await userEvent.click(screen.getByRole('button', { name: 'Show details for b.pdf' }));
    await userEvent.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/jobs');
  });

  it('says how to move with the keyboard', () => {
    page(many(3));
    expect(within(listRegion()).getByText(/select/)).toBeInTheDocument();
  });
});
