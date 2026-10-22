import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { fakeApi, job } from './fake-api.js';
import { JOB_ID, reviewData } from './review-fixture.js';

/** The job list (the detail panel repeats the selected job's name and actions). */
const list = async () => within(await screen.findByRole('region', { name: 'Job list' }));

describe('App', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('titles the browser tab after the current page', async () => {
    window.location.hash = '#/workbench';
    render(<App api={fakeApi()} pollMs={0} />);
    await waitFor(() => expect(document.title).toBe('Workbench · CT Studio'));
    window.location.hash = '#/results';
    await waitFor(() => expect(document.title).toBe('Results · CT Studio'));
  });

  it('shows an empty state when there are no jobs', async () => {
    window.location.hash = '#/jobs';
    render(<App api={fakeApi()} pollMs={0} />);
    expect(await screen.findByText('No jobs yet.')).toBeInTheDocument();
  });

  it('renders jobs and offers retry only for failed ones', async () => {
    window.location.hash = '#/jobs';
    const api = fakeApi({
      listJobs: async () => [
        job({ filename: 'ok.pdf', status: 'succeeded' }),
        job({ id: 'f', filename: 'bad.pdf', status: 'failed', error: 'schema mismatch' }),
      ],
    });
    render(<App api={api} pollMs={0} />);

    const jobs = await list();
    expect(await jobs.findByText('bad.pdf')).toBeInTheDocument();
    expect(jobs.getByText('schema mismatch')).toBeInTheDocument();
    const retry = jobs.getAllByRole('button', { name: /^Retry / });
    expect(retry).toHaveLength(1);

    await userEvent.click(retry[0]!);
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }),
    );
    expect(api.retryJob).toHaveBeenCalledWith('f', null); // the job had no model: its type's
  });

  it('surfaces API errors', async () => {
    render(
      <App
        api={fakeApi({
          listJobs: async () => {
            throw new Error('503 Service Unavailable');
          },
        })}
        pollMs={0}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('503');
  });
});

describe('review routing', () => {
  it('links jobs awaiting review to the review screen', async () => {
    window.location.hash = '#/jobs';
    const api = fakeApi({
      listJobs: async () => [
        job({
          id: 'r1',
          filename: 'scan.pdf',
          status: 'awaiting_review',
          reviewReasons: ['2 unmatched'],
        }),
      ],
    });
    render(<App api={api} pollMs={0} />);
    const jobs = await list();
    const link = await jobs.findByRole('link', { name: 'Review' });
    expect(link).toHaveAttribute('href', '#/review/r1');
    expect(jobs.getByText('2 unmatched')).toBeInTheDocument();
  });

  it('renders the review screen for #/review/<id>', async () => {
    window.location.hash = '#/review/r1';
    const api = fakeApi();
    render(<App api={api} pollMs={0} />);
    await vi.waitFor(() => expect(api.getReview).toHaveBeenCalledWith('r1'));
    window.location.hash = '';
  });

  it('counts the review queue from every job awaiting review, not only the newest', async () => {
    window.location.hash = `#/review/${JOB_ID}`;
    const waiting = [
      job({ id: JOB_ID, status: 'awaiting_review', createdAt: '2020-01-01T00:00:00Z' }),
      job({ id: 'next-id', status: 'awaiting_review', createdAt: '2020-01-02T00:00:00Z' }),
    ];
    const api = fakeApi({
      getReview: vi.fn(async () => reviewData()),
      listJobs: vi.fn(async (opts?: { group?: string }) =>
        opts?.group === 'attention' ? waiting : [],
      ),
    });
    render(<App api={api} pollMs={0} />);
    expect(await screen.findByText('1 of 2 awaiting review')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Next document/ })).toHaveAttribute(
      'href',
      '#/review/next-id',
    );
    window.location.hash = '';
  });

  it('links to Results and marks it current on results pages', async () => {
    window.location.hash = '#/results';
    render(<App api={fakeApi()} pollMs={0} />);
    const link = await screen.findByRole('link', { name: 'Results' });
    expect(link).toHaveAttribute('href', '#/results');
    expect(link).toHaveAttribute('aria-current', 'page');
    window.location.hash = '';
  });

  it("retries with the job's own model choice, not the upload form's", async () => {
    localStorage.setItem('ih.uploadModel', 'test'); // the upload form's remembered choice
    window.location.hash = '#/jobs';
    const api = fakeApi({
      listJobs: async () => [job({ id: 'f', filename: 'bad.pdf', status: 'failed' })],
    });
    render(<App api={api} pollMs={0} />);
    await userEvent.click(await (await list()).findByRole('button', { name: 'Retry bad.pdf' }));
    const dialog = screen.getByRole('dialog', { name: 'Retry bad.pdf' });
    expect(within(dialog).getByRole('combobox', { name: 'Model' })).toHaveValue('');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(api.retryJob).toHaveBeenCalledWith('f', null);
    localStorage.removeItem('ih.uploadModel');
    window.location.hash = '';
  });
});
