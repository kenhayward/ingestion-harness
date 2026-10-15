import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChangePassword } from '../src/access/ChangePassword.js';
import { ApiError, type Me } from '../src/api/client.js';
import { fakeApi } from './fake-api.js';

const KEN: Me = {
  role: 'user',
  label: 'Ken',
  email: 'ken@example.com',
  mustChangePassword: true,
};

async function fill(current: string, next: string, repeat = next) {
  if (current)
    await userEvent.type(screen.getByLabelText(/^(One-time|Current) password$/), current);
  if (next) await userEvent.type(screen.getByLabelText('New password'), next);
  if (repeat) await userEvent.type(screen.getByLabelText('Repeat the new password'), repeat);
}

describe('ChangePassword', () => {
  it('first sign-in: one-time password, the new one twice, then done', async () => {
    const api = fakeApi();
    const onDone = vi.fn();
    render(<ChangePassword api={api} me={KEN} mode="first" onDone={onDone} onSignOut={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
    await fill('abcd-efgh-jkmn-pqrs', 'my long new phrase', 'my long new phrase!');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The two new passwords differ.');
    expect(api.changePassword).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('New password'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(api.changePassword).toHaveBeenCalledWith('abcd-efgh-jkmn-pqrs', 'my long new phrase!');
    expect(onDone).toHaveBeenCalled();
  });

  it('says how long a password must be before sending', async () => {
    const api = fakeApi();
    render(<ChangePassword api={api} me={KEN} mode="first" onDone={vi.fn()} onSignOut={vi.fn()} />);
    await fill('abcd-efgh-jkmn-pqrs', 'a'.repeat(11));
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Use at least 12 characters.');
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it('states the rules', () => {
    render(
      <ChangePassword api={fakeApi()} me={KEN} mode="first" onDone={vi.fn()} onSignOut={vi.fn()} />,
    );
    expect(
      screen.getByText(
        '12 to 200 characters, different from the current one, and not containing your email address. A passphrase of a few words works well.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the server refusal', async () => {
    const api = fakeApi({
      changePassword: vi.fn(async () => {
        throw new ApiError('the password must not contain your email address', 400);
      }),
    });
    const onDone = vi.fn();
    render(<ChangePassword api={api} me={KEN} mode="first" onDone={onDone} onSignOut={vi.fn()} />);
    await fill('abcd-efgh-jkmn-pqrs', 'ken-long-phrase-2026');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'the password must not contain your email address',
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a locked account says when to try again', async () => {
    const until = new Date(Date.now() + 15 * 60_000).toISOString();
    const api = fakeApi({
      changePassword: vi.fn(async () => {
        throw new ApiError('too many failed sign-ins', 429, { lockedUntil: until });
      }),
    });
    render(
      <ChangePassword api={api} me={KEN} mode="account" onDone={vi.fn()} onSignOut={vi.fn()} />,
    );
    await fill('my old long phrase', 'my new long phrase');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Too many failed sign-ins for this account\. Try again after/,
    );
  });

  it('from the account menu: current password, Change password and Cancel', async () => {
    const api = fakeApi();
    const onDone = vi.fn();
    render(
      <ChangePassword
        api={api}
        me={{ ...KEN, mustChangePassword: false }}
        mode="account"
        onDone={onDone}
        onSignOut={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Change your password' })).toBeVisible();
    await fill('my old long phrase', 'my new long phrase');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(api.changePassword).toHaveBeenCalledWith('my old long phrase', 'my new long phrase');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Password changed. Your other sessions are signed out.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('first sign-in offers Sign out instead', async () => {
    const onSignOut = vi.fn();
    render(
      <ChangePassword
        api={fakeApi()}
        me={KEN}
        mode="first"
        onDone={vi.fn()}
        onSignOut={onSignOut}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
  });
});
