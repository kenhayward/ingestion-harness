import type { ResultSummary } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { fakeApi, job } from './fake-api.js';

const SEARCH = 'Search jobs, results and document types';

afterEach(() => {
  window.location.hash = '';
});

describe('app shell', () => {
  it('has a top bar with search, colour mode, Upload PDF and the signed-in token', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({ role: 'user' as const, label: 'Ken – laptop', expiresAt: null })),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('searchbox', { name: SEARCH })).toBeInTheDocument();
    expect(within(banner).getByRole('group', { name: 'Colour mode' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Upload PDF' })).toBeInTheDocument();
    expect(
      within(banner).getByRole('group', { name: 'Signed in as Ken – laptop (user)' }),
    ).toHaveTextContent('KL');
    expect(within(banner).getByRole('link', { name: 'Ingestion Harness' })).toHaveAttribute(
      'href',
      '#/',
    );
  });

  it('badges Jobs with the number of jobs needing attention', async () => {
    const api = fakeApi({
      listJobs: vi.fn(async () =>
        (['awaiting_review', 'failed', 'running', 'succeeded'] as const).map((status) =>
          job({ status }),
        ),
      ),
    });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(await within(nav).findByText('2 need attention')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /^Jobs/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('shows no badge when nothing needs attention', async () => {
    render(
      <App
        api={fakeApi({ listJobs: vi.fn(async () => [job({ status: 'succeeded' })]) })}
        pollMs={0}
      />,
    );
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await screen.findByRole('button', { name: 'Show details for invoice.pdf' });
    expect(within(nav).queryByText(/need attention/)).not.toBeInTheDocument();
  });

  it('marks the parent page current on child screens', async () => {
    window.location.hash = '#/templates/x/1';
    render(<App api={fakeApi()} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Document types' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: /^Jobs/ })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'Workbench' })).toHaveAttribute(
      'href',
      '#/workbench',
    );
  });

  it('focuses search on Ctrl+K, not on a plain k, and Escape clears it', async () => {
    render(<App api={fakeApi()} pollMs={0} />);
    const search = await screen.findByRole('searchbox', { name: SEARCH });
    await userEvent.keyboard('k');
    expect(search).not.toHaveFocus();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(search).toHaveFocus();
    await userEvent.type(search, 'acme');
    expect(search).toHaveValue('acme');
    await userEvent.keyboard('{Escape}');
    expect(search).toHaveValue('');
  });
});

const token = (id: string, label: string) => ({
  id,
  label,
  role: 'user' as const,
  createdAt: '2026-10-01T00:00:00Z',
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  status: 'active' as const,
});

const template = (id: string, name: string) => ({
  id,
  name,
  description: null,
  published: 1,
  draft: null,
  versions: [],
});

const result = (filename: string): ResultSummary => ({
  jobId: filename,
  documentId: filename,
  filename,
  specId: 'pvp',
  specVersion: 1,
  publishedAt: '2026-10-02T08:00:00Z',
  reviewer: null,
  reviewedAt: null,
  outputCount: 1,
  issueCount: 0,
});

describe('search', () => {
  it('filters jobs and says when nothing matches', async () => {
    const api = fakeApi({
      listJobs: vi.fn(async () => [
        job({ filename: 'inv-0042-acme.pdf' }),
        job({ filename: 'coa-lot-7781.pdf', specId: 'certificate' }),
      ]),
    });
    render(<App api={api} pollMs={0} />);
    const shown = (name: string) =>
      screen.queryByRole('button', { name: `Show details for ${name}` });
    await screen.findByRole('button', { name: 'Show details for coa-lot-7781.pdf' });
    const search = screen.getByRole('searchbox', { name: SEARCH });
    await userEvent.type(search, 'acme');
    expect(shown('inv-0042-acme.pdf')).toBeInTheDocument();
    expect(shown('coa-lot-7781.pdf')).not.toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'globex');
    expect(screen.getByText('No jobs match “globex”.')).toBeInTheDocument();
    expect(screen.queryByText('No jobs yet.')).not.toBeInTheDocument();
  });

  it('filters document types by name or id', async () => {
    window.location.hash = '#/templates';
    const api = fakeApi({
      listTemplates: vi.fn(async () => [
        template('supplier-invoice', 'Supplier invoice'),
        template('coa', 'Certificate of analysis'),
      ]),
    });
    render(<App api={api} pollMs={0} />);
    await screen.findByText('Certificate of analysis');
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH }), 'invoice');
    expect(screen.getByText('Supplier invoice')).toBeInTheDocument();
    expect(screen.queryByText('Certificate of analysis')).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH }), ' zzz');
    expect(screen.getByText('No document types match “invoice zzz”.')).toBeInTheDocument();
  });

  it('filters access tokens by label', async () => {
    window.location.hash = '#/access';
    const api = fakeApi({
      listTokens: vi.fn(async () => [token('1', 'Ken – laptop'), token('2', 'Ops station')]),
    });
    render(<App api={api} pollMs={0} />);
    await screen.findByText('Ops station');
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH }), 'ken');
    expect(screen.getByText('Ken – laptop')).toBeInTheDocument();
    expect(screen.queryByText('Ops station')).not.toBeInTheDocument();
  });

  it('filters loaded results by file name', async () => {
    window.location.hash = '#/results';
    const api = fakeApi({
      listResults: vi.fn(async () => [result('a-acme.pdf'), result('b-globex.pdf')]),
    });
    render(<App api={api} pollMs={0} />);
    await screen.findByText('b-globex.pdf');
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH }), 'acme');
    expect(screen.getByText('a-acme.pdf')).toBeInTheDocument();
    expect(screen.queryByText('b-globex.pdf')).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH }), 'x');
    expect(screen.getByText('No results match “acmex”.')).toBeInTheDocument();
  });
});

describe('Upload PDF', () => {
  it('goes to Jobs and opens the file picker once', async () => {
    window.location.hash = '#/results';
    const click = vi.spyOn(HTMLInputElement.prototype, 'click');
    const pickerOpens = () =>
      click.mock.contexts.filter((c) => c instanceof HTMLInputElement && c.type === 'file').length;
    render(<App api={fakeApi()} pollMs={0} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Upload PDF' }));
    const input = await screen.findByLabelText('PDF files');
    await vi.waitFor(() => expect(click.mock.contexts).toContain(input));
    expect(window.location.hash).toBe('#/');
    expect(pickerOpens()).toBe(1);
    // leaving and returning to Jobs must not reopen the picker
    window.location.hash = '#/results';
    await screen.findByRole('heading', { name: 'Results' });
    await vi.waitFor(() => expect(screen.queryByLabelText('PDF files')).not.toBeInTheDocument());
    window.location.hash = '#/';
    await screen.findByLabelText('PDF files');
    expect(pickerOpens()).toBe(1);
    click.mockRestore();
  });
});

describe('search scope', () => {
  it('clears the search when moving to another section', async () => {
    render(
      <App
        api={fakeApi({ listJobs: vi.fn(async () => [job({ filename: 'a.pdf' })]) })}
        pollMs={0}
      />,
    );
    const search = await screen.findByRole('searchbox', { name: SEARCH });
    await userEvent.type(search, 'invoice');
    window.location.hash = '#/access';
    await screen.findByRole('table', { name: 'Access tokens' });
    expect(search).toHaveValue('');
  });

  it('keeps the search on child screens of the same section', async () => {
    window.location.hash = '#/templates';
    render(<App api={fakeApi()} pollMs={0} />);
    const search = await screen.findByRole('searchbox', { name: SEARCH });
    await userEvent.type(search, 'invoice');
    window.location.hash = '#/templates/x/1';
    await vi.waitFor(() => expect(window.location.hash).toBe('#/templates/x/1'));
    expect(search).toHaveValue('invoice');
  });

  it('says when no tokens match', async () => {
    window.location.hash = '#/access';
    const api = fakeApi({ listTokens: vi.fn(async () => [token('1', 'Ken – laptop')]) });
    render(<App api={api} pollMs={0} />);
    await screen.findByText('Ken – laptop');
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH }), 'zzz');
    expect(screen.getByText('No tokens match “zzz”.')).toBeInTheDocument();
  });
});
