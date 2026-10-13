import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JobSummary } from '@ih/shared';
import { HomePage } from '../src/home/HomePage.js';
import { fakeApi, job } from './fake-api.js';

function home(jobs: JobSummary[], me = 'ken') {
  const api = fakeApi();
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
