import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LinkDialog } from '../src/templates/github/LinkDialog.js';
import { fakeApi, profile } from './fake-api.js';

const repos = [
  { fullName: 'acme/other', private: true },
  { fullName: 'acme/recipes', private: false },
];

function setup(
  link: Parameters<typeof LinkDialog>[0]['link'] = null,
  over: Parameters<typeof fakeApi>[0] = {},
) {
  const api = fakeApi({
    listGitHubRepos: vi.fn(async () => repos),
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
    ...over,
  });
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <LinkDialog api={api} templateId="invoice" link={link} onSaved={onSaved} onClose={onClose} />,
  );
  return { api, onSaved, onClose };
}

describe('LinkDialog', () => {
  it('offers the suggested repository first and saves the body exactly', async () => {
    const { api, onSaved } = setup();
    const select = await screen.findByRole('combobox', { name: 'Repository' });
    await waitFor(() => expect(select).toHaveValue('acme/recipes'));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options[0]).toBe('acme/recipes (suggested repository)');
    expect(
      screen.getByRole('checkbox', { name: "Push each version when it's published" }),
    ).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Always open a pull request' })).not.toBeChecked();

    await userEvent.clear(screen.getByRole('textbox', { name: 'Branch' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Branch' }), 'recipes');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Always open a pull request' }));
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));

    expect(api.setGitHubLink).toHaveBeenCalledWith('invoice', {
      repo: 'acme/recipes',
      branch: 'recipes',
      root: 'ct-studio',
      alwaysPr: true,
      pushOnPublish: true,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("starts a new link in Integration's default folder", async () => {
    const { api } = setup(null, {
      getGitHubSettings: vi.fn(async () => ({
        instanceName: 'production',
        instanceId: 'inst-1',
        defaultRoot: 'data/ct',
        locked: false,
      })),
    });
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('data/ct'),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Link' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(api.setGitHubLink).toHaveBeenCalledWith(
      'invoice',
      expect.objectContaining({ root: 'data/ct' }),
    );
  });

  it('keeps an existing link in its own folder', async () => {
    setup(
      {
        repo: 'acme/other',
        branch: 'main',
        root: 'kept/here',
        alwaysPr: false,
        pushOnPublish: true,
        setBy: 'admin',
        setAt: '2026-10-01T00:00:00.000Z',
      },
      {
        getGitHubSettings: vi.fn(async () => ({
          instanceName: 'production',
          instanceId: 'inst-1',
          defaultRoot: 'data/ct',
          locked: false,
        })),
      },
    );
    await screen.findByRole('combobox', { name: 'Repository' });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('kept/here');
  });

  it('needs a branch and a folder, and trims them', async () => {
    const { api } = setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Link' })).toBeEnabled());
    const branch = screen.getByRole('textbox', { name: 'Branch' });
    await userEvent.clear(branch);
    await userEvent.type(branch, '   ');
    expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled();
    expect(screen.getByText('Name the branch and the folder.')).toBeInTheDocument();
    await userEvent.type(branch, 'dev  ');
    const folder = screen.getByRole('textbox', { name: 'Folder' });
    await userEvent.clear(folder);
    expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled();
    await userEvent.type(folder, ' ct ');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(api.setGitHubLink).toHaveBeenCalledWith(
      'invoice',
      expect.objectContaining({ branch: 'dev', root: 'ct' }),
    );
  });

  it('asks an admin without a linked account to link it in Profile first', async () => {
    const { api } = setup(null, {
      getProfile: vi.fn(async () => profile({ github: null })),
      listGitHubRepos: vi.fn(async () => {
        throw new Error('Link your GitHub account in Profile first');
      }),
    });
    expect(
      await screen.findByText('Link your GitHub account in Profile first'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Repository' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled();
    expect(api.setGitHubLink).not.toHaveBeenCalled();
  });

  it('shows a refusal as an alert', async () => {
    const { api, onSaved } = setup();
    api.setGitHubLink = vi.fn(async () => {
      throw new Error('Your GitHub account can read acme/recipes but not push to it.');
    });
    await screen.findByRole('combobox', { name: 'Repository' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Link' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('can read acme/recipes');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('changes an existing link and unlinks it', async () => {
    const { api, onSaved } = setup({
      repo: 'acme/other',
      branch: 'main',
      root: 'data/ct',
      alwaysPr: true,
      pushOnPublish: false,
      setBy: 'admin',
      setAt: '2026-10-01T00:00:00.000Z',
    });
    expect(await screen.findByRole('combobox', { name: 'Repository' })).toHaveValue('acme/other');
    expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('data/ct');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(api.removeGitHubLink).toHaveBeenCalledWith('invoice');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe('GitHub sync help', () => {
  it('opens from its button', async () => {
    setup();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Help: How GitHub sync works' }),
    );
    expect(screen.getByRole('dialog', { name: 'How GitHub sync works' })).toHaveTextContent(
      'On GitHub',
    );
  });
});
