import type { JobSummary } from '@ih/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobsPage } from '../src/jobs/JobsPage.js';
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
