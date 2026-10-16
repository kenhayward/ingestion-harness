import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Me, type SignInEvent, type User } from '../src/api/client.js';
import { AccessPage } from '../src/access/AccessPage.js';
import { ADMIN_FROM_LOG, ADMIN_ME, fakeApi, user } from './fake-api.js';

const HOUR = 3_600_000;
const KEN = user({ id: '11111111-1111-4111-8111-111111111111', name: 'Ken Hayward' });
const ANN = user({
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Ann',
  email: 'ann@example.com',
  role: 'admin',
  status: 'locked',
  failedSignIns: 10,
  lockedUntil: new Date(Date.now() + HOUR / 4).toISOString(),
});
const BOB = user({
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Bob',
  email: 'bob@example.com',
  status: 'disabled',
  disabledReason: 'failed-sign-ins',
  disabledAt: new Date(Date.now() - HOUR).toISOString(),
  failedSignIns: 20,
});
const USERS = [ADMIN_FROM_LOG, ANN, BOB, KEN];

/** The table row of the user named `name` (its accessible name starts with the name cell). */
const row = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name}\\b`) });
const findRow = async (name: string) =>
  screen.findByRole('row', { name: new RegExp(`^${name}\\b`) });

const page = (overrides: Parameters<typeof fakeApi>[0] = {}, me: Me = ADMIN_ME) => {
  const api = fakeApi({ listUsers: vi.fn(async () => USERS), ...overrides });
  render(<AccessPage api={api} me={me} />);
  return api;
};

const withPassword = (u: User, password = 'abcd-efgh-jkmn-pqrs') => ({ user: u, password });

afterEach(() => vi.unstubAllGlobals());

describe('AccessPage', () => {
  it('lists users with their status, the admin from the log first', async () => {
    page();
    const ken = await findRow('Ken Hayward');
    expect(within(ken).getByText('ken@example.com')).toBeVisible();
    expect(within(ken).getByText('Active')).toBeVisible();
    expect(within(ken).getByText('Never signed in')).toBeVisible();
    expect(within(row('Ann')).getByText(/^Locked until /)).toBeVisible();
    expect(within(row('Ann')).getByText('10 failed sign-ins')).toBeVisible();
    expect(within(row('Bob')).getByText('Disabled: 20 failed sign-ins')).toBeVisible();
    const admin = row('Admin');
    expect(within(admin).getByText('admin')).toBeVisible(); // signs in as
    expect(
      within(admin)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Sign-in history for Admin']);
    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(names[0]).toMatch(/^Admin/);
  });

  it('shows failed attempts on a row before it locks', async () => {
    page({ listUsers: vi.fn(async () => [ADMIN_FROM_LOG, { ...KEN, failedSignIns: 3 }]) });
    expect(within(await findRow('Ken Hayward')).getByText('3 failed sign-ins')).toBeVisible();
  });

  it('adds a user and shows the one-time password once', async () => {
    const added = user({ name: 'Cat', email: 'cat@example.com', status: 'must-change' });
    const addUser = vi.fn(async () => withPassword(added));
    const listUsers = vi
      .fn()
      .mockResolvedValueOnce([ADMIN_FROM_LOG])
      .mockResolvedValue([ADMIN_FROM_LOG, added]);
    page({ addUser, listUsers });
    await userEvent.click(await screen.findByRole('button', { name: 'Add user' }));
    const dialog = screen.getByRole('dialog', { name: 'Add user' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Cat');
    await userEvent.type(within(dialog).getByLabelText('Email address'), 'cat@example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Admin' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add user' }));
    expect(addUser).toHaveBeenCalledWith({ name: 'Cat', email: 'cat@example.com', role: 'admin' });
    const notice = await screen.findByRole('region', { name: 'One-time password for Cat' });
    expect(within(notice).getByDisplayValue('abcd-efgh-jkmn-pqrs')).toBeInTheDocument();
    expect(notice).toHaveTextContent(
      'Shown once. It works for 7 days, and Cat chooses their own password at first sign-in.',
    );
    expect(await findRow('Cat')).toBeInTheDocument();
    await userEvent.click(within(notice).getByRole('button', { name: 'Done' }));
    expect(screen.queryByDisplayValue('abcd-efgh-jkmn-pqrs')).not.toBeInTheDocument();
  });

  it('keeps a refused add in the dialog', async () => {
    page({
      addUser: vi.fn(async () => {
        throw new ApiError('a user with this email already exists', 409);
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add user' }));
    const dialog = screen.getByRole('dialog', { name: 'Add user' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Ken 2');
    await userEvent.type(within(dialog).getByLabelText('Email address'), 'ken@example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add user' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'a user with this email already exists',
    );
  });

  it('needs a name and a valid-looking email before adding', async () => {
    page();
    await userEvent.click(await screen.findByRole('button', { name: 'Add user' }));
    const dialog = screen.getByRole('dialog', { name: 'Add user' });
    const add = within(dialog).getByRole('button', { name: 'Add user' });
    expect(add).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Cat');
    await userEvent.type(within(dialog).getByLabelText('Email address'), 'cat');
    expect(add).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Email address'), '@example.com');
    expect(add).toBeEnabled();
  });

  it('edits name, email and role, sending only what changed', async () => {
    const updateUser = vi.fn(async () => ({ ...KEN, email: 'ken@new.example' }));
    page({ updateUser });
    await userEvent.click(
      within(await findRow('Ken Hayward')).getByRole('button', { name: 'Edit Ken Hayward' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit Ken Hayward' });
    const email = within(dialog).getByLabelText('Email address');
    expect(email).toHaveValue('ken@example.com');
    await userEvent.clear(email);
    await userEvent.type(email, 'ken@new.example');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(updateUser).toHaveBeenCalledWith(KEN.id, { email: 'ken@new.example' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('disables only after confirming; Keep sends nothing', async () => {
    const setUserEnabled = vi.fn(async () => ({ ...KEN, status: 'disabled' as const }));
    page({ setUserEnabled });
    const ken = await findRow('Ken Hayward');
    await userEvent.click(within(ken).getByRole('button', { name: 'Disable Ken Hayward' }));
    expect(
      within(row('Ken Hayward')).getByText('Disable? They are signed out at once.'),
    ).toBeInTheDocument();
    await userEvent.click(within(row('Ken Hayward')).getByRole('button', { name: 'Keep' }));
    expect(setUserEnabled).not.toHaveBeenCalled();
    await userEvent.click(
      within(row('Ken Hayward')).getByRole('button', { name: 'Disable Ken Hayward' }),
    );
    const confirm = within(row('Ken Hayward')).getByRole('button', { name: 'Disable now' });
    expect(confirm).toHaveFocus();
    await userEvent.click(confirm);
    expect(setUserEnabled).toHaveBeenCalledWith(KEN.id, false);
  });

  it('unlocks a locked user without a confirm; Disable is still there', async () => {
    const setUserEnabled = vi.fn(async () => ({ ...ANN, status: 'active' as const }));
    page({ setUserEnabled });
    const ann = await findRow('Ann');
    expect(within(ann).getByRole('button', { name: 'Disable Ann' })).toBeInTheDocument();
    await userEvent.click(within(ann).getByRole('button', { name: 'Unlock Ann' }));
    expect(setUserEnabled).toHaveBeenCalledWith(ANN.id, true);
  });

  it('re-enables a user disabled by failed sign-ins', async () => {
    const setUserEnabled = vi.fn(async () => ({ ...BOB, status: 'active' as const }));
    page({ setUserEnabled });
    await userEvent.click(within(await findRow('Bob')).getByRole('button', { name: 'Enable Bob' }));
    expect(setUserEnabled).toHaveBeenCalledWith(BOB.id, true);
  });

  it('reissues after confirming and shows the new password', async () => {
    const reissuePassword = vi.fn(async () => withPassword(KEN, 'wxyz-wxyz-wxyz-wxyz'));
    page({ reissuePassword });
    const ken = await findRow('Ken Hayward');
    await userEvent.click(
      within(ken).getByRole('button', { name: 'Reissue one-time password for Ken Hayward' }),
    );
    expect(
      within(row('Ken Hayward')).getByText(
        'Reissue? Their current password stops working and they are signed out.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(row('Ken Hayward')).getByRole('button', { name: 'Reissue now' }));
    expect(reissuePassword).toHaveBeenCalledWith(KEN.id);
    const notice = await screen.findByRole('region', { name: 'One-time password for Ken Hayward' });
    expect(within(notice).getByDisplayValue('wxyz-wxyz-wxyz-wxyz')).toBeInTheDocument();
  });

  it('cannot disable or demote yourself', async () => {
    const me: Me = {
      role: 'admin',
      label: 'Ann',
      email: 'ann@example.com',
      mustChangePassword: false,
      userId: ANN.id,
    };
    const annActive = { ...ANN, status: 'active' as const, lockedUntil: null, failedSignIns: 0 };
    page({ listUsers: vi.fn(async () => [ADMIN_FROM_LOG, annActive]) }, me);
    const ann = await findRow('Ann');
    const disable = within(ann).getByRole('button', { name: 'Disable Ann' });
    expect(disable).toBeDisabled();
    expect(disable).toHaveAttribute('title', 'You cannot disable yourself');
    const reissue = within(ann).getByRole('button', {
      name: 'Reissue one-time password for Ann',
    });
    expect(reissue).toBeDisabled();
    expect(reissue).toHaveAttribute('title', 'Change your own password from the account menu');
    await userEvent.click(within(ann).getByRole('button', { name: 'Edit Ann' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Ann' });
    expect(within(dialog).getByRole('button', { name: 'User' })).toBeDisabled();
  });

  it('shows a refusal from a row action', async () => {
    page({
      setUserEnabled: vi.fn(async () => {
        throw new ApiError('you cannot disable yourself', 409);
      }),
    });
    await userEvent.click(within(await findRow('Bob')).getByRole('button', { name: 'Enable Bob' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('you cannot disable yourself');
  });

  it('filters by chip', async () => {
    page();
    await findRow('Ken Hayward');
    await userEvent.click(screen.getByRole('button', { name: /^Locked/ }));
    expect(row('Ann')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /^Ken Hayward\b/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Disabled/ }));
    expect(row('Bob')).toBeInTheDocument();
  });

  it('copies the one-time password, saying so', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    page({ reissuePassword: vi.fn(async () => withPassword(KEN)) });
    await userEvent.click(
      within(await findRow('Ken Hayward')).getByRole('button', {
        name: 'Reissue one-time password for Ken Hayward',
      }),
    );
    await userEvent.click(within(row('Ken Hayward')).getByRole('button', { name: 'Reissue now' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('abcd-efgh-jkmn-pqrs');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('explains manual copying when the clipboard is unavailable (plain-HTTP LAN)', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    page({ reissuePassword: vi.fn(async () => withPassword(KEN)) });
    await userEvent.click(
      within(await findRow('Ken Hayward')).getByRole('button', {
        name: 'Reissue one-time password for Ken Hayward',
      }),
    );
    await userEvent.click(within(row('Ken Hayward')).getByRole('button', { name: 'Reissue now' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Copying needs HTTPS here: select the password and copy it manually.',
    );
  });

  it('Sign-in history filters the panel to that user, and Clear goes back', async () => {
    const listSignIns = vi.fn(async (): Promise<SignInEvent[]> => []);
    page({ listSignIns });
    await userEvent.click(
      within(await findRow('Ken Hayward')).getByRole('button', {
        name: 'Sign-in history for Ken Hayward',
      }),
    );
    expect(listSignIns).toHaveBeenLastCalledWith({ userId: KEN.id, limit: 50 });
    expect(screen.getByRole('combobox', { name: 'Whose sign-ins' })).toHaveValue(KEN.id);
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(listSignIns).toHaveBeenLastCalledWith({ limit: 50 });
  });

  it('is for admins only', () => {
    render(
      <AccessPage
        api={fakeApi()}
        me={{
          role: 'user',
          label: 'Ken',
          email: 'ken@example.com',
          mustChangePassword: false,
          userId: 'u-test',
        }}
      />,
    );
    expect(screen.getByText('Admins only.')).toBeInTheDocument();
  });

  it('leaves the data-lake S3 keys to the Integration tab', async () => {
    page();
    expect(await screen.findByRole('table', { name: 'Users' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Data lake S3 keys' })).toBeNull();
  });
});
