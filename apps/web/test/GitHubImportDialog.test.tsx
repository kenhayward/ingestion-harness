import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteVersion } from '@ih/shared';
import { ImportDialog } from '../src/templates/github/ImportDialog.js';
import { fakeApi, profile, templateView } from './fake-api.js';

const remote = (o: Partial<RemoteVersion> = {}): RemoteVersion => ({
  instance: 'staging',
  typeId: 'memo',
  version: 3,
  label: 'Trial',
  note: null,
  publishedBy: 'Ken',
  publishedAt: '2026-10-01T09:00:00.000Z',
  definitionSha256: 'abc',
  commit: 'cafebabe1234',
  path: 'ct-studio/staging/memo/v3.yaml',
  mine: false,
  ...o,
});

function setup(admin: boolean, over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    listReadableGitHubRepos: vi.fn(async () => [
      { fullName: 'acme/other', private: true },
      { fullName: 'acme/recipes', private: false },
    ]),
    getProfile: vi.fn(async () =>
      profile({
        github: {
          login: 'ken',
          avatarUrl: 'https://example.com/a.png',
          linkedAt: '2026-10-01T00:00:00.000Z',
          repo: 'acme/recipes',
        },
      }),
    ),
    getGitHubSettings: vi.fn(async () => ({
      instanceName: 'production',
      instanceId: 'inst-1',
      defaultRoot: 'recipes-root',
      locked: false,
    })),
    browseGitHub: vi.fn(async () => ({ versions: [remote()], skipped: [] })),
    importFromGitHub: vi.fn(async () => ({
      ...templateView({ id: 'memo', version: 1 }),
      linked: admin,
    })),
    ...over,
  });
  const onOpened = vi.fn();
  render(<ImportDialog api={api} admin={admin} onOpened={onOpened} onClose={vi.fn()} />);
  return { api, onOpened };
}

async function browse() {
  const repo = await screen.findByRole('combobox', { name: 'Repository' });
  await waitFor(() => expect(repo).toHaveValue('acme/recipes'));
  await userEvent.click(screen.getByRole('button', { name: 'Browse' }));
}

describe('ImportDialog', () => {
  it('suggests the profile repository first and browses with the admin default folder', async () => {
    const { api } = setup(true);
    await browse();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options[0]).toBe('acme/recipes (suggested repository)');
    await waitFor(() =>
      expect(api.browseGitHub).toHaveBeenCalledWith({
        repo: 'acme/recipes',
        branch: 'main',
        root: 'recipes-root',
      }),
    );
  });

  it('uses ct-studio as the folder for non-admins and hides the link tick box', async () => {
    const { api } = setup(false);
    await browse();
    expect(api.getGitHubSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(api.browseGitHub).toHaveBeenCalled());
    expect(vi.mocked(api.browseGitHub).mock.calls[0]![0].root).toBe('ct-studio');
    await userEvent.click(await screen.findByRole('radio', { name: /v3/ }));
    expect(screen.queryByRole('checkbox', { name: /Keep it in sync/ })).not.toBeInTheDocument();
  });

  it('pre-fills id and name from the pick, names the folder in the hint, and imports', async () => {
    const { api, onOpened } = setup(true);
    await browse();
    await userEvent.click(await screen.findByRole('radio', { name: /v3/ }));
    expect(screen.getByRole('textbox', { name: 'Id' })).toHaveValue('memo');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('memo');
    expect(screen.getByRole('checkbox', { name: /Keep it in sync/ })).toBeChecked();
    expect(
      screen.getByText('It will write under recipes-root/production/, never staging/.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importFromGitHub).toHaveBeenCalledWith({
        repo: 'acme/recipes',
        branch: 'main',
        path: 'ct-studio/staging/memo/v3.yaml',
        commit: 'cafebabe1234',
        id: 'memo',
        name: 'memo',
        link: true,
      }),
    );
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith('memo', 1));
  });

  it('shows the clash message from a 409', async () => {
    const { onOpened } = setup(true, {
      importFromGitHub: vi.fn(async () => {
        throw new Error('memo already exists: import under another id');
      }),
    });
    await browse();
    await userEvent.click(await screen.findByRole('radio', { name: /v3/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('memo already exists');
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('forgets the browsed pick when the repository, branch or folder changes', async () => {
    const { api } = setup(true);
    await browse();
    await userEvent.click(await screen.findByRole('radio', { name: /v3/ }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Branch' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Branch' }), 'dev');
    expect(screen.queryByRole('radio', { name: /v3/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(api.importFromGitHub).not.toHaveBeenCalled();
  });
});

describe('GitHub sync help', () => {
  it('opens from its button', async () => {
    setup(true);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Help: How GitHub sync works' }),
    );
    expect(screen.getByRole('dialog', { name: 'How GitHub sync works' })).toHaveTextContent(
      'On GitHub',
    );
  });
});
