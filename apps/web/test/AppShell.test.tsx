import type { ResultSummary } from '@ih/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { fakeApi, job, projectView } from './fake-api.js';

const SEARCH = 'Search jobs, results and document types';

afterEach(() => {
  window.location.hash = '';
});

describe('app shell', () => {
  it('has a top bar with search, colour mode and the signed-in user', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'designer' as const,
        label: 'Ken – laptop',
        email: null,
        mustChangePassword: false,
        userId: 'u-test',
      })),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('searchbox', { name: SEARCH })).toBeInTheDocument();
    expect(within(banner).getByRole('group', { name: 'Colour mode' })).toBeInTheDocument();
    // Uploading is Home's (its Upload documents card): the top bar has no Upload button.
    expect(within(banner).queryByRole('button', { name: /upload/i })).toBeNull();
    expect(
      within(banner).getByRole('button', { name: 'Ken – laptop (Designer): account menu' }),
    ).toHaveTextContent('KL');
    const home = within(banner).getByRole('link', {
      name: 'CT Studio — Content Transformation Studio, home',
    });
    expect(home).toHaveAttribute('href', '#/');
    expect(home).toHaveAttribute('title', 'Content Transformation Studio');
    expect(home).toHaveTextContent('CT Studio');
    expect(home.querySelector('svg')).toHaveAttribute('data-geometry', 'small');
  });

  it.each(['designer', 'admin'] as const)(
    'links %s sessions to the API docs in a new tab',
    async (role) => {
      const api = fakeApi({
        me: vi.fn(async () => ({
          role,
          label: 'Ken',
          email: null,
          mustChangePassword: false,
          userId: 'u-test',
        })),
      });
      render(<App api={api} pollMs={0} />);
      const nav = await screen.findByRole('navigation', { name: 'Main' });
      const link = within(nav).getByRole('link', { name: 'API docs (opens in a new tab)' });
      expect(link).toHaveAttribute('href', '/api/docs/');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener');
    },
  );

  it('shows the build version at the bottom of the nav', async () => {
    render(<App api={fakeApi()} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText('dev')).toBeInTheDocument();
  });

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
        userId: 'u-test',
      })),
      getProject: vi.fn(async () => projectView()),
    });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav).toHaveClass('compact');
    for (const name of ['Jobs', 'Results', 'Document types', 'Workbench', 'Ontologies']) {
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
    window.location.hash = '#/templates';
    await screen.findByRole('heading', { level: 1, name: 'Document types' });
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
});

describe('the admin name menu', () => {
  it('opens Administration and Sign out from the name of an admin', async () => {
    const onSignOut = vi.fn();
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'admin' as const,
        label: 'Ken',
        email: null,
        mustChangePassword: false,
        userId: 'u-test',
      })),
      logout: vi.fn(async () => {
        onSignOut();
      }),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    const trigger = within(banner).getByRole('button', {
      name: 'Ken (Administrator): account menu',
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(within(banner).queryByRole('menu')).toBeNull();
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = within(banner).getByRole('menu', { name: 'Ken (Administrator): account menu' });
    // Administration first; Models, Linked data and Access are no longer links of their own.
    const items = within(menu).getAllByRole('menuitem');
    expect(items[0]).toHaveAccessibleName('Administration');
    for (const gone of ['Models', 'Linked data', 'Access']) {
      expect(within(menu).queryByRole('menuitem', { name: gone })).toBeNull();
    }
    await userEvent.keyboard('{Escape}');
    expect(within(banner).queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(within(banner).getByRole('menuitem', { name: 'Administration' }));
    expect(within(banner).queryByRole('menu')).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Administration' });
    expect(window.location.hash).toBe('');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(within(banner).getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(onSignOut).toHaveBeenCalled());
  });

  it('opens Help from the account menu, for everyone', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'designer' as const,
        label: 'Ann',
        email: 'ann@example.com',
        mustChangePassword: false,
        userId: 'u-test',
      })),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    await userEvent.click(
      within(banner).getByRole('button', { name: 'Ann (Designer): account menu' }),
    );
    await userEvent.click(within(banner).getByRole('menuitem', { name: 'Help' }));
    const dialog = screen.getByRole('dialog', { name: 'Help' });
    expect(within(dialog).getByText('/ Introduction')).toBeInTheDocument();
  });

  it('opens Help on a topic from #/help/<topic>, over Home', async () => {
    window.location.hash = '#/help/sections';
    render(<App api={fakeApi()} pollMs={0} />);
    const dialog = await screen.findByRole('dialog', { name: 'Help' });
    expect(within(dialog).getByText('/ How sections work')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/');
  });

  it('gives users a menu with Profile, Help and Sign out; Profile opens the dialog', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'designer' as const,
        label: 'Ann',
        email: 'ann@example.com',
        mustChangePassword: false,
        userId: 'u-test',
      })),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    const trigger = within(banner).getByRole('button', { name: 'Ann (Designer): account menu' });
    await userEvent.click(trigger);
    const menu = within(banner).getByRole('menu', { name: 'Ann (Designer): account menu' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Profile', 'Help', 'Sign out']);
    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(within(banner).getByRole('menuitem', { name: 'Profile' }));
    const dialog = screen.getByRole('dialog', { name: 'Profile' });
    expect(within(dialog).getByRole('tab', { name: 'Personal details' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(window.location.hash).toBe('');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still opens the Change password page at its address', async () => {
    window.location.hash = '#/account/password';
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'designer' as const,
        label: 'Ann',
        email: 'ann@example.com',
        mustChangePassword: false,
        userId: 'u-test',
      })),
    });
    render(<App api={api} pollMs={0} />);
    expect(
      await screen.findByRole('heading', { name: 'Change your password' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Change password · CT Studio'));
  });

  it('lists Profile for admin users but not for the admin from the log', async () => {
    const menuItems = async (email: string | null) => {
      const api = fakeApi({
        me: vi.fn(async () => ({
          role: 'admin' as const,
          label: 'Ken',
          email,
          mustChangePassword: false,
          userId: 'u-test',
        })),
      });
      const { unmount } = render(<App api={api} pollMs={0} />);
      const banner = await screen.findByRole('banner');
      await userEvent.click(
        within(banner).getByRole('button', { name: 'Ken (Administrator): account menu' }),
      );
      const items = within(within(banner).getByRole('menu')).getAllByRole('menuitem');
      const names = items.map((i) => i.textContent);
      unmount();
      return names;
    };
    expect(await menuItems('ken@example.com')).toContain('Profile');
    expect(await menuItems(null)).not.toContain('Profile');
  });

  it('shows the linked GitHub picture beside the name', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'designer' as const,
        label: 'Ann',
        email: 'ann@example.com',
        mustChangePassword: false,
        userId: 'u-test',
        avatarUrl: 'https://avatars.example/u/7',
      })),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    const trigger = within(banner).getByRole('button', { name: 'Ann (Designer): account menu' });
    expect(trigger.querySelector('img.avatar')).toHaveAttribute(
      'src',
      'https://avatars.example/u/7',
    );
    expect(trigger).not.toHaveTextContent('AN');
  });

  it('reopens Profile when GitHub sends the browser back, and re-reads who is signed in', async () => {
    window.location.hash = '#/account/profile/github?github=linked';
    const me = vi.fn(async () => ({
      role: 'designer' as const,
      label: 'Ann',
      email: 'ann@example.com',
      mustChangePassword: false,
      userId: 'u-test',
    }));
    const api = fakeApi({ me });
    render(<App api={api} pollMs={0} />);
    const dialog = await screen.findByRole('dialog', { name: 'Profile' });
    expect(await within(dialog).findByRole('status')).toHaveTextContent('GitHub account linked.');
    await waitFor(() => expect(window.location.hash).toBe('#/'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(me.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('has no admin links in the nav', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'admin' as const,
        label: 'Ken',
        email: null,
        mustChangePassword: false,
        userId: 'u-test',
      })),
    });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await within(nav).findByRole('link', { name: 'Workbench' });
    for (const gone of ['Models', 'Linked data', 'Access']) {
      expect(within(nav).queryByRole('link', { name: gone })).toBeNull();
    }
    expect(within(nav).queryByText('Admin')).toBeNull();
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
