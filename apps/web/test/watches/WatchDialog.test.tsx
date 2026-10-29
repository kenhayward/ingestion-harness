import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WatchDialog } from '../../src/watches/WatchDialog.js';
import { fakeApi, watchSource, watchView } from '../fake-api.js';

const SOURCES = [watchSource()];

function setup(
  o: { watch?: ReturnType<typeof watchView>; api?: Parameters<typeof fakeApi>[0] } = {},
) {
  const onSaved = vi.fn();
  const api = fakeApi(o.api);
  render(
    <WatchDialog
      api={api}
      sources={SOURCES}
      {...(o.watch ? { watch: o.watch } : {})}
      onClose={() => undefined}
      onSaved={onSaved}
    />,
  );
  return { api, onSaved };
}

async function fillNew() {
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Inbox');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'documents');
  await userEvent.type(screen.getByRole('textbox', { name: 'Space' }), 'SPACE-1');
  await userEvent.type(screen.getByRole('textbox', { name: 'Folder' }), 'Inbox');
}

describe('the watch dialog', () => {
  it('keeps Save disabled until the folder has been tested, and again once it changes', async () => {
    const testWatch = vi.fn(async () => ({ ok: true as const, files: 4 }));
    setup({ api: { testWatch } });
    await fillNew();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Test folder' }));
    expect(await screen.findByText('4 files found at the folder root.')).toBeInTheDocument();
    expect(testWatch).toHaveBeenCalledWith({
      targetId: 'documents',
      source: { space: 'SPACE-1', folder: 'Inbox' },
    });
    expect(save).toBeEnabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder' }), '2');
    expect(save).toBeDisabled();
  });

  it('shows the problem a failed test found and keeps Save disabled', async () => {
    const testWatch = vi.fn(async () => ({ ok: false as const, problem: 'folder not found' }));
    setup({ api: { testWatch } });
    await fillNew();
    await userEvent.click(screen.getByRole('button', { name: 'Test folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('folder not found');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('creates the watch with its defaults', async () => {
    const created = watchView();
    const createWatch = vi.fn(async () => created);
    const { onSaved } = setup({ api: { createWatch } });
    await fillNew();
    await userEvent.click(screen.getByRole('button', { name: 'Test folder' }));
    await screen.findByText(/files? found/);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(createWatch).toHaveBeenCalledWith({
        name: 'Inbox',
        targetId: 'documents',
        source: { space: 'SPACE-1', folder: 'Inbox' },
        force: false,
        autoApprove: true,
        reasonFiles: true,
        sleepSeconds: 30,
        admit: 10,
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(created);
  });

  it('shows a refusal of the save', async () => {
    const createWatch = vi.fn(async () => {
      throw new Error('a watch named Inbox exists');
    });
    setup({ api: { createWatch } });
    await fillNew();
    await userEvent.click(screen.getByRole('button', { name: 'Test folder' }));
    await screen.findByText(/files? found/);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('a watch named Inbox exists');
  });

  it('offers Browse only for a source field that can be browsed', async () => {
    setup();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'documents');
    expect(screen.getByRole('button', { name: 'Browse space' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Browse folder' })).toBeNull();
  });

  it('locks the folder and target of a watch that is not stopped, saying why', () => {
    setup({ watch: watchView() });
    expect(screen.getByRole('dialog', { name: 'Reconfigure Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Target' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Space' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Folder' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Run as me' })).toBeDisabled();
    expect(screen.getAllByText(/stop the watch to change/i).length).toBeGreaterThan(0);
    // The other settings stay editable, and need no test of the folder.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Test folder' })).toBeNull();
  });

  it('saves only what changed on a running watch', async () => {
    const w = watchView();
    const updateWatch = vi.fn(async () => ({ ...w, admit: 20 }));
    const { onSaved } = setup({ watch: w, api: { updateWatch } });
    expect(screen.getByRole('spinbutton', { name: 'Sleep when idle (seconds)' })).toBeEnabled();
    const admit = screen.getByRole('spinbutton', { name: 'Admit at a time' });
    await userEvent.clear(admit);
    await userEvent.type(admit, '20');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateWatch).toHaveBeenCalledWith(w.id, { admit: 20 }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('lets a stopped watch change its folder, tested first, and says it will run as you', async () => {
    const w = watchView({ state: 'stopped', health: 'stopped' });
    const updateWatch = vi.fn(async () => w);
    const testWatch = vi.fn(async () => ({ ok: true as const, files: 0 }));
    setup({ watch: w, api: { updateWatch, testWatch } });
    const folder = screen.getByRole('textbox', { name: 'Folder' });
    expect(folder).toBeEnabled();
    await userEvent.clear(folder);
    await userEvent.type(folder, 'Other');
    expect(screen.getAllByText(/runs as you/i).length).toBeGreaterThan(0);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Test folder' }));
    await screen.findByText(/files? found/);
    await userEvent.click(save);
    await waitFor(() =>
      expect(updateWatch).toHaveBeenCalledWith(w.id, {
        source: { space: 'SPACE-1', folder: 'Other' },
      }),
    );
  });

  it('takes a stopped watch over with Run as me', async () => {
    const w = watchView({ state: 'stopped', health: 'stopped' });
    const updateWatch = vi.fn(async () => w);
    setup({ watch: w, api: { updateWatch } });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Run as me' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateWatch).toHaveBeenCalledWith(w.id, { runAsMe: true }));
  });

  it('browses a source field and takes the picked node', async () => {
    const browseWatchSource = vi.fn(async () => ({
      nodes: [
        { id: 'SPACE-9', label: 'Policies', kind: 'space', hasChildren: false, selectable: true },
      ],
      nextCursor: null,
    }));
    setup({ api: { browseWatchSource } });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'documents');
    await userEvent.click(screen.getByRole('button', { name: 'Browse space' }));
    const browse = within(await screen.findByRole('dialog', { name: 'Choose space' }));
    await userEvent.click(await browse.findByRole('button', { name: 'Policies' }));
    expect(screen.getByRole('textbox', { name: 'Space' })).toHaveValue('SPACE-9');
    expect(browseWatchSource).toHaveBeenCalledWith({
      targetId: 'documents',
      field: 'space',
      parentId: null,
      cursor: null,
    });
  });
});
