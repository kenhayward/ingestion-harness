import type { ResultSummary } from '@ih/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { fakeApi, job, projectView, user } from './fake-api.js';

const SEARCH = 'Search jobs, results and document types';

afterEach(() => {
  window.location.hash = '';
});

describe('app shell', () => {
  it('has a top bar with search, colour mode, Upload document and the signed-in token', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'user' as const,
        label: 'Ken – laptop',
        email: null,
        mustChangePassword: false,
      })),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('searchbox', { name: SEARCH })).toBeInTheDocument();
    expect(within(banner).getByRole('group', { name: 'Colour mode' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Upload document' })).toBeInTheDocument();
    expect(
      within(banner).getByRole('group', { name: 'Signed in as Ken – laptop (user)' }),
    ).toHaveTextContent('KL');
    const home = within(banner).getByRole('link', {
      name: 'CT Studio — Content Transformation Studio, home',
    });
    expect(home).toHaveAttribute('href', '#/');
    expect(home).toHaveAttribute('title', 'Content Transformation Studio');
    expect(home).toHaveTextContent('CT Studio');
    expect(home.querySelector('svg')).toHaveAttribute('data-geometry', 'small');
  });

  it.each(['user', 'admin'] as const)(
    'links %s sessions to the API docs in a new tab',
    async (role) => {
      const api = fakeApi({
        me: vi.fn(async () => ({ role, label: 'Ken', email: null, mustChangePassword: false })),
      });
      render(<App api={api} pollMs={0} />);
      const nav = await screen.findByRole('navigation', { name: 'Main' });
      const link = within(nav).getByRole('link', { name: 'API docs (opens in a new tab)' });
      expect(link).toHaveAttribute('href', '/api/docs/');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener');
    },
  );

  it('badges Jobs with the number of jobs needing attention', async () => {
    window.location.hash = '#/jobs';
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
    window.location.hash = '#/jobs';
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

  it('collapses the main nav to labelled icons on a project page only', async () => {
    window.location.hash = '#/workbench/letter';
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'admin' as const,
        label: 'Ken',
        email: null,
        mustChangePassword: false,
      })),
      getProject: vi.fn(async () => projectView()),
    });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav).toHaveClass('compact');
    for (const name of ['Jobs', 'Results', 'Document types', 'Workbench', 'Access']) {
      const link = within(nav).getByRole('link', { name });
      expect(link).toHaveAttribute('title', name);
    }
    window.location.hash = '#/templates';
    await waitFor(() => expect(nav).not.toHaveClass('compact'));
    expect(within(nav).getByRole('link', { name: 'Document types' })).not.toHaveAttribute('title');
  });

  it('keeps announcing jobs needing attention on the compact Jobs link', async () => {
    window.location.hash = '#/workbench/letter';
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      listJobs: vi.fn(async () =>
        (['awaiting_review', 'failed', 'running', 'succeeded'] as const).map((status) =>
          job({ status }),
        ),
      ),
    });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const link = await within(nav).findByRole('link', { name: 'Jobs, 2 need attention' });
    expect(link).toHaveAttribute('title', 'Jobs, 2 need attention');
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

const template = (id: string, name: string) => ({
  id,
  name,
  description: null,
  published: 1,
  draft: null,
  retired: null,
  versions: [],
  summary: {
    sections: 1,
    fields: 1,
    tables: 0,
    references: 0,
    draftIssues: null,
    lastRegression: null,
    regressionRunning: false,
  },
});

const result = (filename: string): ResultSummary => ({
  jobId: filename,
  documentId: filename,
  filename,
  contentType: 'application/pdf',
  specId: 'pvp',
  specVersion: 1,
  publishedAt: '2026-10-02T08:00:00Z',
  reviewer: null,
  reviewedAt: null,
  outputCount: 1,
  outputs: [],
  issueCount: 0,
});

describe('search', () => {
  it('filters jobs and says when nothing matches', async () => {
    window.location.hash = '#/jobs';
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

  it('filters users by name or email', async () => {
    window.location.hash = '#/access';
    const api = fakeApi({
      listUsers: vi.fn(async () => [
        user({ id: '1', name: 'Ken Hayward', email: 'ken@example.com' }),
        user({ id: '2', name: 'Ops station', email: 'ops@example.com' }),
      ]),
    });
    render(<App api={api} pollMs={0} />);
    const users = within(await screen.findByRole('table', { name: 'Users' }));
    await users.findByText('Ops station');
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH }), 'ken@');
    expect(users.getByText('Ken Hayward')).toBeInTheDocument();
    expect(users.queryByText('Ops station')).not.toBeInTheDocument();
  });

  it('sends the search to the server as the results file name filter', async () => {
    window.location.hash = '#/results';
    const listResults = vi.fn(async (query?: { q?: string }) =>
      [result('a-acme.pdf'), result('b-globex.pdf')].filter(
        (r) => !query?.q || r.filename.includes(query.q),
      ),
    );
    render(<App api={fakeApi({ listResults })} pollMs={0} />);
    await screen.findByRole('button', { name: 'Show preview of b-globex.pdf' });
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH }), 'acme');
    expect(screen.getByRole('searchbox', { name: 'Filter by file name' })).toHaveValue('acme');
    await vi.waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Show preview of b-globex.pdf' }),
      ).not.toBeInTheDocument(),
    );
    expect(listResults).toHaveBeenLastCalledWith({ templateId: undefined, q: 'acme' });
  });
});

describe('Upload document', () => {
  it('goes to Jobs and opens the file picker once', async () => {
    window.location.hash = '#/results';
    const click = vi.spyOn(HTMLInputElement.prototype, 'click');
    const pickerOpens = () =>
      click.mock.contexts.filter((c) => c instanceof HTMLInputElement && c.type === 'file').length;
    render(<App api={fakeApi()} pollMs={0} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Upload document' }));
    const input = await screen.findByLabelText('PDF or Word files');
    await vi.waitFor(() => expect(click.mock.contexts).toContain(input));
    expect(window.location.hash).toBe('#/');
    expect(pickerOpens()).toBe(1);
    // leaving and returning to Jobs must not reopen the picker
    window.location.hash = '#/results';
    await screen.findByRole('heading', { name: 'Results' });
    await vi.waitFor(() =>
      expect(screen.queryByLabelText('PDF or Word files')).not.toBeInTheDocument(),
    );
    window.location.hash = '#/';
    await screen.findByLabelText('PDF or Word files');
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
    await screen.findByRole('table', { name: 'Users' });
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

  it('says when no users match', async () => {
    window.location.hash = '#/access';
    const api = fakeApi({ listUsers: vi.fn(async () => [user({ name: 'Ken Hayward' })]) });
    render(<App api={api} pollMs={0} />);
    await within(await screen.findByRole('table', { name: 'Users' })).findByText('Ken Hayward');
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH }), 'zzz');
    expect(screen.getByText('No users match “zzz”.')).toBeInTheDocument();
  });
});

describe('the admin name menu', () => {
  it('opens Models, Access and Sign out from the name of an admin', async () => {
    const onSignOut = vi.fn();
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'admin' as const,
        label: 'Ken',
        email: null,
        mustChangePassword: false,
      })),
      logout: vi.fn(async () => {
        onSignOut();
      }),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    const trigger = within(banner).getByRole('button', { name: 'Ken (admin): account menu' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(within(banner).queryByRole('menu')).toBeNull();
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = within(banner).getByRole('menu', { name: 'Ken (admin): account menu' });
    expect(within(menu).getByRole('menuitem', { name: 'Models' })).toHaveAttribute(
      'href',
      '#/models',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Access' })).toHaveAttribute(
      'href',
      '#/access',
    );
    await userEvent.keyboard('{Escape}');
    expect(within(banner).queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(within(banner).getByRole('menuitem', { name: 'Models' }));
    expect(window.location.hash).toBe('#/models');
    expect(within(banner).queryByRole('menu')).toBeNull();
    await userEvent.click(trigger);
    await userEvent.click(within(banner).getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(onSignOut).toHaveBeenCalled());
  });

  it('keeps a plain chip with Sign out for users', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'user' as const,
        label: 'Ann',
        email: null,
        mustChangePassword: false,
      })),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    expect(within(banner).queryByRole('button', { name: /account menu/ })).toBeNull();
    expect(within(banner).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('lists Models in the admin nav', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'admin' as const,
        label: 'Ken',
        email: null,
        mustChangePassword: false,
      })),
    });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Models' })).toHaveAttribute('href', '#/models');
  });
});

describe('Home and the collapsible nav', () => {
  afterEach(() => localStorage.removeItem('ih.navCollapsed'));

  it('lists Home first, at #/, with Jobs at #/jobs', async () => {
    render(<App api={fakeApi()} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links[0]).toHaveAccessibleName('Home');
    expect(links[0]).toHaveAttribute('href', '#/');
    expect(links[0]).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: /^Jobs/ })).toHaveAttribute('href', '#/jobs');
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
  });

  it('collapses and expands on any page, and remembers it', async () => {
    window.location.hash = '#/results';
    const view = render(<App api={fakeApi()} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav).not.toHaveClass('compact');
    await userEvent.click(screen.getByRole('button', { name: 'Collapse menu' }));
    expect(nav).toHaveClass('compact');
    expect(within(nav).getByRole('link', { name: 'Results' })).toHaveAttribute('title', 'Results');
    expect(localStorage.getItem('ih.navCollapsed')).toBe('1');
    view.unmount();

    render(<App api={fakeApi()} pollMs={0} />);
    const again = await screen.findByRole('navigation', { name: 'Main' });
    expect(again).toHaveClass('compact');
    const expand = screen.getByRole('button', { name: 'Expand menu' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(expand);
    expect(again).not.toHaveClass('compact');
    expect(localStorage.getItem('ih.navCollapsed')).toBeNull();
  });

  it('starts collapsed on a project page, and can be expanded there', async () => {
    window.location.hash = '#/workbench/letter';
    const api = fakeApi({ getProject: vi.fn(async () => projectView()) });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav).toHaveClass('compact');
    await userEvent.click(screen.getByRole('button', { name: 'Expand menu' }));
    expect(nav).not.toHaveClass('compact');
    // Only for this visit: the remembered choice is for the other pages.
    expect(localStorage.getItem('ih.navCollapsed')).toBeNull();
  });
});
