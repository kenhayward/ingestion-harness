import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectListPage } from '@ih/shared';
import type { Api } from '../src/api/client.js';
import { rememberProject } from '../src/workbench/listDerive.js';
import { WorkbenchPage } from '../src/workbench/WorkbenchPage.js';
import { fakeApi, projectListItem, projectListPage, projectView } from './fake-api.js';

type Query = Parameters<Api['listProjectPage']>[0];

const page = (api = fakeApi(), onNavigate = vi.fn(), query?: string) =>
  render(<WorkbenchPage api={api} onNavigate={onNavigate} query={query} />);

/** The main list's requests (the cards' requests carry `ids`). */
const listCalls = (api: Api): Query[] =>
  vi
    .mocked(api.listProjectPage)
    .mock.calls.map(([q]) => q)
    .filter((q) => q.ids === undefined);
const lastListCall = (api: Api) => listCalls(api).at(-1);

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const invoice = projectListItem({ id: 'invoice', name: 'Invoice' });

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkbenchPage', () => {
  it('requests the first page with the defaults and shows the table and range', async () => {
    const api = fakeApi();
    page(api);
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: 'Letter' })).toHaveAttribute(
      'href',
      '#/workbench/letter',
    );
    expect(listCalls(api)).toEqual([{ filter: 'all', sort: 'activity', page: 1, size: 25 }]);
    expect(screen.getByText('Showing 1–1 of 1')).toBeInTheDocument();
  });

  it('shows the server counts on the chips and filters by one', async () => {
    const api = fakeApi({
      listProjectPage: vi.fn(async () =>
        projectListPage({
          total: 1000,
          facets: {
            all: 1000,
            attention: 37,
            running: 18,
            ready: 9,
            progress: 212,
            published: 788,
          },
        }),
      ),
    });
    page(api);
    const chips = screen.getByRole('group', { name: 'Filter projects' });
    expect(await within(chips).findByRole('button', { name: /All\s*1,000/ })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: /Published, no draft\s*788/ })).toBeTruthy();
    await userEvent.click(within(chips).getByRole('button', { name: /Needs you/ }));
    await waitFor(() =>
      expect(lastListCall(api)).toEqual({
        filter: 'attention',
        sort: 'activity',
        page: 1,
        size: 25,
      }),
    );
  });

  it('debounces the search into one request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi();
    page(api);
    await screen.findByRole('table');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(
      screen.getByRole('searchbox', { name: 'Search projects by name or id' }),
      'inv',
    );
    expect(listCalls(api)).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(listCalls(api)).toHaveLength(2);
    expect(lastListCall(api)).toEqual({
      q: 'inv',
      filter: 'all',
      sort: 'activity',
      page: 1,
      size: 25,
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(listCalls(api)).toHaveLength(2);
  });

  it('seeds the search from the top bar and follows it', async () => {
    const api = fakeApi();
    const { rerender } = page(api, vi.fn(), 'let');
    expect(screen.getByRole('searchbox', { name: 'Search projects by name or id' })).toHaveValue(
      'let',
    );
    await screen.findByRole('table');
    expect(listCalls(api)[0]).toMatchObject({ q: 'let' });
    rerender(<WorkbenchPage api={api} onNavigate={vi.fn()} query="inv" />);
    expect(screen.getByRole('searchbox', { name: 'Search projects by name or id' })).toHaveValue(
      'inv',
    );
    await waitFor(() => expect(lastListCall(api)).toMatchObject({ q: 'inv', page: 1 }));
  });

  it('ignores an older response that arrives after a newer one', async () => {
    const first = deferred<ProjectListPage>();
    const second = deferred<ProjectListPage>();
    const api = fakeApi({
      listProjectPage: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise) as Api['listProjectPage'],
    });
    page(api);
    await userEvent.click(screen.getByRole('button', { name: /^Running/ }));
    await waitFor(() => expect(listCalls(api)).toHaveLength(2));
    await act(async () => second.resolve(projectListPage({ items: [invoice] })));
    await act(async () => first.resolve(projectListPage()));
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: 'Invoice' })).toBeInTheDocument();
    expect(within(table).queryByRole('link', { name: 'Letter' })).toBeNull();
  });

  it('pages, and goes back to page 1 when the sort changes', async () => {
    const api = fakeApi({
      listProjectPage: vi.fn(async () => projectListPage({ total: 1000 })),
    });
    page(api);
    const pager = await screen.findByRole('navigation', { name: 'Pages' });
    await waitFor(() =>
      expect(
        within(pager)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['‹', '1', '2', '3', '40', '›']),
    );
    expect(pager).toHaveTextContent('…');
    expect(within(pager).getByRole('button', { name: '1' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(pager).getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastListCall(api)).toMatchObject({ page: 2 }));
    await userEvent.click(within(pager).getByRole('button', { name: '3' }));
    await waitFor(() => expect(lastListCall(api)).toMatchObject({ page: 3 }));
    expect(within(pager).getByRole('button', { name: '3' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'Name A–Z');
    await waitFor(() => expect(lastListCall(api)).toMatchObject({ sort: 'name', page: 1 }));
  });

  it('filters by phase and models', async () => {
    const api = fakeApi();
    page(api);
    await screen.findByRole('table');
    await userEvent.selectOptions(screen.getByLabelText('Phase'), 'Verify and publish');
    await waitFor(() => expect(lastListCall(api)).toMatchObject({ phase: 'verify', page: 1 }));
    await userEvent.selectOptions(screen.getByLabelText('Models'), 'External allowed');
    await waitFor(() =>
      expect(lastListCall(api)).toMatchObject({ phase: 'verify', policy: 'external' }),
    );
  });

  it('remembers the rows per page', async () => {
    const api = fakeApi();
    page(api);
    await screen.findByRole('table');
    await userEvent.selectOptions(screen.getByLabelText('Rows per page'), '50');
    await waitFor(() => expect(lastListCall(api)).toMatchObject({ size: 50, page: 1 }));
    expect(localStorage.getItem('ih.wbPageSize')).toBe('50');
  });

  it('starts from the stored rows per page', async () => {
    localStorage.setItem('ih.wbPageSize', '100');
    const api = fakeApi();
    page(api);
    await screen.findByRole('table');
    expect(listCalls(api)[0]).toMatchObject({ size: 100 });
  });

  it('says so when nothing matches', async () => {
    const api = fakeApi({
      listProjectPage: vi.fn(async () =>
        projectListPage({
          items: [],
          total: 0,
          facets: { all: 5, attention: 0, running: 0, ready: 0, progress: 5, published: 0 },
        }),
      ),
    });
    page(api);
    expect(
      await screen.findByText('No document types match. Clear the search or pick another filter.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Showing 0 of 0')).toBeInTheDocument();
  });

  it('shows pinned and recent projects as cards, pinned first', async () => {
    rememberProject('letter');
    const api = fakeApi({
      listPins: vi.fn(async () => ['invoice']),
      listProjectPage: vi.fn(async (q: Query) =>
        q.ids
          ? projectListPage({ items: [projectListItem(), invoice], total: 2 })
          : projectListPage(),
      ),
    });
    page(api);
    const cards = await screen.findByRole('region', { name: 'Pinned and recent' });
    expect(api.listProjectPage).toHaveBeenCalledWith({ ids: ['invoice', 'letter'] });
    const articles = await within(cards).findAllByRole('article');
    expect(articles.map((a) => within(a).getAllByRole('link')[0]!.textContent)).toEqual([
      'Invoice',
      'Letter',
    ]);
    expect(within(articles[0]!).getByRole('button', { name: 'Pin Invoice' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(articles[1]!).getByRole('button', { name: 'Pin Letter' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('caps the cards at three ids', async () => {
    ['d', 'c', 'b', 'a'].forEach(rememberProject);
    const api = fakeApi({ listPins: vi.fn(async () => ['p']) });
    page(api);
    await waitFor(() => expect(api.listProjectPage).toHaveBeenCalledWith({ ids: ['p', 'a', 'b'] }));
  });

  it('omits the cards when nothing is pinned or recent', async () => {
    const api = fakeApi();
    page(api);
    await screen.findByRole('table');
    await waitFor(() => expect(api.listPins).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Pinned and recent' })).toBeNull();
    expect(vi.mocked(api.listProjectPage).mock.calls.some(([q]) => q.ids !== undefined)).toBe(
      false,
    );
  });

  it('pins a project and puts it on the cards', async () => {
    const api = fakeApi();
    page(api);
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('button', { name: 'Pin Letter' }));
    expect(api.pin).toHaveBeenCalledWith('letter');
    expect(within(table).getByRole('button', { name: 'Pin Letter' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => expect(api.listProjectPage).toHaveBeenCalledWith({ ids: ['letter'] }));
    expect(await screen.findByRole('region', { name: 'Pinned and recent' })).toBeInTheDocument();
  });

  it('unpins a pinned project', async () => {
    const api = fakeApi({ listPins: vi.fn(async () => ['letter']) });
    page(api);
    const table = await screen.findByRole('table');
    const star = within(table).getByRole('button', { name: 'Pin Letter' });
    await waitFor(() => expect(star).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(star);
    expect(api.unpin).toHaveBeenCalledWith('letter');
    expect(star).toHaveAttribute('aria-pressed', 'false');
  });

  it('reverts the star and shows an error when pinning fails', async () => {
    const api = fakeApi({
      pin: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    page(api);
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('button', { name: 'Pin Letter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(within(table).getByRole('button', { name: 'Pin Letter' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('creates a project from the New project dialog and opens it', async () => {
    const onNavigate = vi.fn();
    const api = fakeApi({ createProject: vi.fn(async () => projectView()) });
    page(api, onNavigate);
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    await userEvent.type(within(dialog).getByLabelText('Id'), 'letter');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Letter');
    expect(dialog).toHaveTextContent('Leave the name empty to open an existing document type.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(api.createProject).toHaveBeenCalledWith('letter', 'Letter');
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/letter');
  });

  it('opens an existing document type without a name', async () => {
    const api = fakeApi({ createProject: vi.fn(async () => projectView()) });
    page(api);
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    await userEvent.type(within(dialog).getByLabelText('Id'), 'letter');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(api.createProject).toHaveBeenCalledWith('letter', undefined);
  });

  it('shows why a project could not be created', async () => {
    const api = fakeApi({
      createProject: vi.fn(async () => {
        throw new Error('letter already exists');
      }),
    });
    page(api);
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    await userEvent.type(within(dialog).getByLabelText('Id'), 'letter');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('letter already exists');
  });

  it('imports a bundle from the Import bundle dialog and opens the new project', async () => {
    const onNavigate = vi.fn();
    const api = fakeApi({ importBundle: vi.fn(async () => projectView()) });
    page(api, onNavigate);
    await userEvent.click(screen.getByRole('button', { name: 'Import bundle' }));
    const dialog = screen.getByRole('dialog', { name: 'Import bundle' });
    await userEvent.upload(
      within(dialog).getByLabelText('Bundle (.zip)'),
      new File(['zip'], 'b.zip', { type: 'application/zip' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('#/workbench/letter'));
  });

  it('shows a list failure', async () => {
    const api = fakeApi({
      listProjectPage: vi.fn(async () => {
        throw new Error('list down');
      }),
    });
    page(api);
    expect(await screen.findByRole('alert')).toHaveTextContent('list down');
  });
});
