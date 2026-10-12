import type { JobSummary } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
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
    pickPending={false}
    onPicked={vi.fn()}
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

  it('keeps the shown job (and an open picker) when a poll brings a newer job needing attention', async () => {
    const a = job({ id: 'a', filename: 'a.pdf', status: 'failed' });
    const { rerender } = page([a]);
    await userEvent.click(
      within(panel()).getByRole('button', { name: 'Retry with another model…' }),
    );
    const b = job({ id: 'b', filename: 'b.pdf', status: 'failed' });
    rerender(element([b, a]));
    expect(within(panel()).getByRole('heading', { name: 'a.pdf' })).toBeInTheDocument();
    expect(within(panel()).getByLabelText('Model for a.pdf')).toBeInTheDocument();
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
