import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Me } from '../src/api/client.js';
import { ProfileDialog } from '../src/access/ProfileDialog.js';
import { fakeApi, profile } from './fake-api.js';

const KEN: Me = {
  userId: 'u1',
  role: 'designer',
  label: 'Ken Hayward',
  email: 'ken@example.com',
  mustChangePassword: false,
  avatarUrl: null,
};
const LINKED = {
  login: 'kenhayward',
  avatarUrl: 'https://avatars.example/u/101',
  linkedAt: '2026-10-15T09:00:00.000Z',
  repo: null,
};

function setup(
  overrides: Parameters<typeof fakeApi>[0] = {},
  props: Partial<Parameters<typeof ProfileDialog>[0]> = {},
) {
  const api = fakeApi(overrides);
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <ProfileDialog
      api={api}
      me={KEN}
      onClose={onClose}
      onChanged={onChanged}
      onSignOut={vi.fn()}
      {...props}
    />,
  );
  return { api, onClose, onChanged, dialog: screen.getByRole('dialog', { name: 'Profile' }) };
}

describe('ProfileDialog layout', () => {
  it('has a ledger of tabs with icons beside the open tab, Personal details first', async () => {
    const { dialog } = setup();
    const tabs = within(dialog).getByRole('tablist', { name: 'Profile sections' });
    expect(tabs).toHaveAttribute('aria-orientation', 'vertical');
    const names = within(tabs).getAllByRole('tab');
    expect(names.map((t) => t.textContent)).toEqual(['Personal details', 'Change password']);
    for (const tab of names) expect(tab.querySelector('svg')).not.toBeNull();
    expect(names[0]).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByRole('tabpanel', { name: 'Personal details' })).toBeVisible();
    // The header says where you are; the side shows who.
    expect(within(dialog).getByText('/ Personal details')).toBeInTheDocument();
    expect(within(dialog).getByText('Ken Hayward', { selector: '.profile-who' })).toBeVisible();
  });

  it('closes only with Close: not a click outside, not Escape', async () => {
    const { dialog, onClose } = setup();
    fireEvent.mouseDown(dialog.parentElement!);
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens on the tab it is given and switches tabs', async () => {
    const { dialog } = setup({}, { initialTab: 'password' });
    expect(within(dialog).getByRole('tab', { name: 'Change password' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(dialog).getByLabelText('Current password')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Personal details' }));
    expect(await within(dialog).findByLabelText('Name')).toBeVisible();
  });

  it('shows the GitHub picture once an account is linked', async () => {
    const { dialog } = setup(
      { getProfile: vi.fn(async () => profile({ github: LINKED })) },
      { me: { ...KEN, avatarUrl: LINKED.avatarUrl } },
    );
    expect(dialog.querySelector('.profile-side img')).toHaveAttribute('src', LINKED.avatarUrl);
  });
});

describe('Personal details', () => {
  it('saves the details on its own Save; email is read-only', async () => {
    const { dialog, api, onChanged } = setup({
      getProfile: vi.fn(async () => profile({ company: 'Acme' })),
    });
    const panel = within(dialog).getByRole('tabpanel', { name: 'Personal details' });
    expect(await within(panel).findByLabelText('Company')).toHaveValue('Acme');
    const email = within(panel).getByLabelText('Email');
    expect(email).toHaveValue('ken@example.com');
    expect(email).toHaveAttribute('readonly');
    expect(within(panel).getByText('An admin changes your email address.')).toBeInTheDocument();
    const save = within(panel).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.clear(within(panel).getByLabelText('Name'));
    await userEvent.type(within(panel).getByLabelText('Name'), 'Ken H');
    await userEvent.type(within(panel).getByLabelText('Job title'), 'Engineer');
    await userEvent.type(within(panel).getByLabelText('LinkedIn'), 'ken-hayward');
    await userEvent.click(save);
    expect(api.updateProfile).toHaveBeenCalledWith({
      name: 'Ken H',
      jobTitle: 'Engineer',
      company: 'Acme',
      linkedin: 'ken-hayward',
    });
    expect(await within(panel).findByRole('status')).toHaveTextContent('Saved.');
    expect(onChanged).toHaveBeenCalled();
    expect(save).toBeDisabled();
  });

  it('keeps a refusal beside the form', async () => {
    const { dialog } = setup({
      updateProfile: vi.fn(async () => {
        throw new ApiError('a user with this name already exists', 409);
      }),
    });
    const panel = within(dialog).getByRole('tabpanel', { name: 'Personal details' });
    await userEvent.type(await within(panel).findByLabelText('Company'), 'Acme');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'a user with this name already exists',
    );
  });
});

describe('GitHub', () => {
  const panelOf = async (dialog: HTMLElement) => {
    const panel = within(dialog).getByRole('tabpanel', { name: 'Personal details' });
    await within(panel).findByLabelText('Name');
    return within(panel).getByRole('group', { name: 'GitHub' });
  };

  it('links by going to GitHub, but not with unsaved details', async () => {
    const { dialog } = setup();
    const github = await panelOf(dialog);
    const link = within(github).getByRole('link', { name: 'Link GitHub account' });
    expect(link).toHaveAttribute('href', '/api/profile/github/connect');
    expect(within(github).getByText(/its picture becomes yours/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Company'), 'Acme');
    expect(within(github).queryByRole('link', { name: 'Link GitHub account' })).toBeNull();
    expect(within(github).getByText('Save your details before linking GitHub.')).toBeVisible();
  });

  it('says when the server cannot link GitHub accounts', async () => {
    const { dialog } = setup({
      getProfile: vi.fn(async () => profile({ githubAvailable: false })),
    });
    const github = await panelOf(dialog);
    expect(within(github).queryByRole('link', { name: 'Link GitHub account' })).toBeNull();
    expect(github).toHaveTextContent('GitHub linking is not set up on this server.');
  });

  it('shows the linked account and unlinks it', async () => {
    const getProfile = vi
      .fn()
      .mockResolvedValueOnce(profile({ github: LINKED }))
      .mockResolvedValue(profile());
    const { dialog, api, onChanged } = setup({ getProfile });
    const github = await panelOf(dialog);
    expect(github).toHaveTextContent('Linked as kenhayward');
    expect(github.querySelector('img')).toHaveAttribute('src', LINKED.avatarUrl);
    await userEvent.click(within(github).getByRole('button', { name: 'Unlink' }));
    expect(api.unlinkGitHub).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    expect(
      await within(github).findByRole('link', { name: 'Link GitHub account' }),
    ).toBeInTheDocument();
  });

  it('chooses the repository recipe YAML will be stored in', async () => {
    const setGitHubRepo = vi.fn(async (repo: string | null) =>
      profile({ github: { ...LINKED, repo } }),
    );
    const { dialog } = setup({
      getProfile: vi.fn(async () => profile({ github: LINKED })),
      listGitHubRepos: vi.fn(async () => [
        { fullName: 'kenhayward/recipes', private: true },
        { fullName: 'acme/shared', private: false },
      ]),
      setGitHubRepo,
    });
    const github = await panelOf(dialog);
    expect(github).toHaveTextContent('Recipe YAML will be stored in this repository');
    const select = await within(github).findByRole('combobox', { name: 'YAML repository' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['None chosen', 'kenhayward/recipes (private)', 'acme/shared']);
    const save = within(github).getByRole('button', { name: 'Save repository' });
    expect(save).toBeDisabled();
    await userEvent.selectOptions(select, 'kenhayward/recipes');
    await userEvent.click(save);
    expect(setGitHubRepo).toHaveBeenCalledWith('kenhayward/recipes');
    expect(await within(github).findByRole('status')).toHaveTextContent('Repository saved.');
  });

  it('says what GitHub said when the repositories cannot be read', async () => {
    const { dialog } = setup({
      getProfile: vi.fn(async () => profile({ github: { ...LINKED, repo: 'kenhayward/old' } })),
      listGitHubRepos: vi.fn(async () => {
        throw new ApiError('GitHub no longer accepts this link: link the account again', 502);
      }),
    });
    const github = await panelOf(dialog);
    expect(await within(github).findByRole('alert')).toHaveTextContent(
      'GitHub no longer accepts this link: link the account again',
    );
    expect(github).toHaveTextContent('kenhayward/old');
  });

  it.each([
    ['linked', 'status', 'GitHub account linked.'],
    ['denied', 'alert', 'GitHub did not link the account: you declined on GitHub.'],
    ['expired', 'alert', 'The GitHub link took too long or was started elsewhere: try again.'],
    ['taken', 'alert', 'That GitHub account is linked to another user.'],
    ['failed', 'alert', 'GitHub could not be reached to link the account: try again.'],
  ] as const)('reports how the link ended: %s', async (result, role, text) => {
    const { dialog } = setup({}, { githubResult: result });
    const github = await panelOf(dialog);
    expect(within(github).getByRole(role)).toHaveTextContent(text);
  });
});

describe('Change password', () => {
  it('changes the password inside the dialog', async () => {
    const { dialog, api } = setup({}, { initialTab: 'password' });
    const panel = within(dialog).getByRole('tabpanel', { name: 'Change password' });
    await userEvent.type(within(panel).getByLabelText('Current password'), 'my old long phrase');
    await userEvent.type(within(panel).getByLabelText('New password'), 'my new long phrase');
    await userEvent.type(
      within(panel).getByLabelText('Repeat the new password'),
      'my new long phrase',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Change password' }));
    expect(api.changePassword).toHaveBeenCalledWith('my old long phrase', 'my new long phrase');
    expect(await within(panel).findByRole('status')).toHaveTextContent('Password changed.');
    expect(within(panel).queryByRole('button', { name: 'Back' })).toBeNull();
  });
});
