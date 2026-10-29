import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WatchedFoldersPage } from '../../src/watches/WatchedFoldersPage.js';
import { fakeApi, watchSource, watchView } from '../fake-api.js';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const ID = '9b3e5c10-6d1a-4e77-8f20-2a4c6e8b0d11';

function pageApi(watches = [watchView()], overrides: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    listWatches: vi.fn(async () => watches),
    listWatchSources: vi.fn(async () => [watchSource()]),
    ...overrides,
  });
}
const ledger = async () => within(await screen.findByRole('table', { name: 'Watched folders' }));
const open = async (name: string) => {
  await userEvent.click(
    await (await ledger()).findByRole('button', { name: `Actions for ${name}` }),
  );
  return within(screen.getByRole('menu', { name: `Actions for ${name}` }));
};

describe('the Watched folders page', () => {
  it('lists each watch with its health, queue and throughput', async () => {
    const api = pageApi([
      watchView({
        queue: { waiting: 3, inProgress: 2 },
        throughput: {
          day: { delivered: 5, failed: 1 },
          total: { delivered: 40, failed: 4 },
        },
        lastPickupAt: '2026-10-29T11:50:00.000Z',
        batchId: '6f1c2a10-4b7e-4c55-9d2a-0c8e7b3f5a11',
      }),
    ]);
    render(<WatchedFoldersPage api={api} now={NOW} />);
    const row = within((await (await ledger()).findByText('Inbox')).closest('tr')!);
    expect(row.getByText('SPACE-1/Inbox')).toBeInTheDocument();
    expect(row.getByText('Controlled documents')).toBeInTheDocument();
    expect(row.getByText('Ken')).toBeInTheDocument();
    expect(row.getByText('Running')).toBeInTheDocument();
    expect(row.getByText('3 waiting · 2 in progress')).toBeInTheDocument();
    expect(row.getByText('5 delivered · 1 failed')).toBeInTheDocument();
    expect(row.getByText('40 delivered · 4 failed')).toBeInTheDocument();
    expect(row.getByText('10 min ago')).toBeInTheDocument();
    expect(row.getByRole('link', { name: 'Batch' })).toHaveAttribute(
      'href',
      '#/conversion/6f1c2a10-4b7e-4c55-9d2a-0c8e7b3f5a11',
    );
  });

  it('says why a watch has a problem', async () => {
    const api = pageApi([
      watchView({ health: 'problem', problem: 'no connection for this target' }),
    ]);
    render(<WatchedFoldersPage api={api} now={NOW} />);
    const row = within((await (await ledger()).findByText('Inbox')).closest('tr')!);
    expect(row.getByText('Problem')).toBeInTheDocument();
    expect(row.getByText('no connection for this target')).toBeInTheDocument();
  });

  it('stops a watch by draining it', async () => {
    const stopWatch = vi.fn(async () => watchView({ state: 'draining', health: 'draining' }));
    render(<WatchedFoldersPage api={pageApi([watchView()], { stopWatch })} now={NOW} />);
    await userEvent.click((await open('Inbox')).getByRole('menuitem', { name: 'Stop…' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Stop Inbox?' }));
    expect(dialog.getByRole('radio', { name: /^Drain/ })).toBeChecked();
    await userEvent.click(dialog.getByRole('button', { name: 'Stop watch' }));
    await waitFor(() => expect(stopWatch).toHaveBeenCalledWith(ID, { mode: 'drain' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops a watch now when asked, saying that files stay where they are', async () => {
    const stopWatch = vi.fn(async () => watchView({ state: 'stopped', health: 'stopped' }));
    render(<WatchedFoldersPage api={pageApi([watchView()], { stopWatch })} now={NOW} />);
    await userEvent.click((await open('Inbox')).getByRole('menuitem', { name: 'Stop…' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Stop Inbox?' }));
    expect(dialog.getByText(/files stay where they are/i)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('radio', { name: /^Stop now/ }));
    await userEvent.click(dialog.getByRole('button', { name: 'Stop watch' }));
    await waitFor(() => expect(stopWatch).toHaveBeenCalledWith(ID, { mode: 'now' }));
  });

  it('offers only Stop now to a draining watch', async () => {
    const api = pageApi([watchView({ state: 'draining', health: 'draining' })]);
    render(<WatchedFoldersPage api={api} now={NOW} />);
    await userEvent.click((await open('Inbox')).getByRole('menuitem', { name: 'Stop…' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Stop Inbox?' }));
    expect(dialog.getByRole('radio', { name: /^Drain/ })).toBeDisabled();
    expect(dialog.getByRole('radio', { name: /^Stop now/ })).toBeChecked();
  });

  it('starts a stopped watch, saying how to retry stuck moves', async () => {
    const stopped = watchView({ state: 'stopped', health: 'stopped' });
    const startWatch = vi.fn(async () => watchView());
    render(<WatchedFoldersPage api={pageApi([stopped], { startWatch })} now={NOW} />);
    const menu = await open('Inbox');
    expect(menu.queryByRole('menuitem', { name: 'Stop…' })).toBeNull();
    expect(menu.getByRole('menuitem', { name: 'Start' })).toHaveAttribute(
      'title',
      expect.stringMatching(/stuck moves/),
    );
    await userEvent.click(menu.getByRole('menuitem', { name: 'Start' }));
    await waitFor(() => expect(startWatch).toHaveBeenCalledWith(ID));
    // The row now shows what the API answered.
    expect(await screen.findByText('Running')).toBeInTheDocument();
  });

  it('removes a stopped watch after a confirm', async () => {
    const stopped = watchView({ state: 'stopped', health: 'stopped' });
    const removeWatch = vi.fn(async () => undefined);
    render(<WatchedFoldersPage api={pageApi([stopped], { removeWatch })} now={NOW} />);
    await userEvent.click((await open('Inbox')).getByRole('menuitem', { name: 'Remove…' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Remove Inbox?' })).getByRole('button', {
        name: 'Remove watch',
      }),
    );
    await waitFor(() => expect(removeWatch).toHaveBeenCalledWith(ID));
    await waitFor(() =>
      expect(screen.queryByRole('table', { name: 'Watched folders' })).toBeNull(),
    );
  });

  it('does not offer Remove or Start while it runs', async () => {
    render(<WatchedFoldersPage api={pageApi()} now={NOW} />);
    const menu = await open('Inbox');
    expect(menu.queryByRole('menuitem', { name: 'Remove…' })).toBeNull();
    expect(menu.queryByRole('menuitem', { name: 'Start' })).toBeNull();
    expect(menu.getByRole('menuitem', { name: 'Reconfigure…' })).toBeInTheDocument();
  });

  it('opens a watch to its settings and newest events', async () => {
    const w = watchView({ sleepSeconds: 45 });
    const api = pageApi([w], {
      getWatch: vi.fn(async () => ({
        watch: w,
        events: [
          {
            id: 2,
            at: '2026-10-29T11:55:00.000Z',
            level: 'warn' as const,
            message: 'could not move a.docx',
            details: null,
          },
          {
            id: 1,
            at: '2026-10-29T11:50:00.000Z',
            level: 'info' as const,
            message: 'picked up b.docx',
            details: null,
          },
        ],
      })),
    });
    render(<WatchedFoldersPage api={api} now={NOW} />);
    await userEvent.click(await (await ledger()).findByRole('button', { name: 'Inbox' }));
    const panel = within(await screen.findByRole('complementary', { name: 'Inbox' }));
    expect(panel.getByText('45 s')).toBeInTheDocument();
    const events = await panel.findAllByRole('listitem');
    expect(events.map((e) => e.textContent)).toEqual([
      expect.stringContaining('could not move a.docx'),
      expect.stringContaining('picked up b.docx'),
    ]);
  });

  it('opens its help from the ?', async () => {
    render(<WatchedFoldersPage api={pageApi()} now={NOW} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Help: Watched folders' }));
    const help = screen.getByRole('dialog', { name: 'Watched folders' });
    expect(help).toHaveTextContent(/stop and start the watch to retry stuck moves/i);
  });

  it('starts a new watch from the page header', async () => {
    render(<WatchedFoldersPage api={pageApi([])} now={NOW} />);
    await userEvent.click(await screen.findByRole('button', { name: 'New watch' }));
    expect(screen.getByRole('dialog', { name: 'New watch' })).toBeInTheDocument();
  });
});
