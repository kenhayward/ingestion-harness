import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ApiError, type Me } from '../src/api/client.js';
import { fakeApi } from './fake-api.js';

const statusError = (status: number, message: string, body: Record<string, unknown> = {}) =>
  new ApiError(message, status, body);

const signedIn = (me: Partial<Me> = {}, failed = 0, lastFailedAt: string | null = null) => ({
  role: 'user' as const,
  label: 'Ken Hayward',
  email: 'ken@example.com',
  mustChangePassword: false,
  userId: 'u-test',
  ...me,
  failedSinceLastSignIn: failed,
  lastFailedAt,
});

async function signInWith(email: string, password: string) {
  await userEvent.type(await screen.findByLabelText('Email address'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('sign-in gate', () => {
  it('titles the sign-in tab', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    await screen.findByRole('button', { name: 'Sign in' });
    await waitFor(() => expect(document.title).toBe('Sign in · CT Studio'));
  });

  it('shows the CT Studio mark and name', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    await screen.findByLabelText('Email address'); // past the loading layout, which has the same brand
    expect(screen.getByRole('heading', { level: 1, name: 'CT Studio' })).toBeInTheDocument();
    expect(document.querySelector('.auth-brand svg')).toHaveAttribute('width', '52');
  });

  it('signs in with an email address and a password, then shows the app', async () => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => signedIn()),
    });
    render(<App api={api} pollMs={0} />);
    const email = await screen.findByLabelText('Email address');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    await signInWith(' ken@example.com ', 'a long phrase here');
    expect(api.login).toHaveBeenCalledWith('ken@example.com', 'a long phrase here');
    expect(await screen.findByText('No jobs yet: upload a document to start.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Ken Hayward (user): account menu' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed sign-ins? since your last visit/)).not.toBeInTheDocument();
  });

  it('links to the API docs, which need no sign-in', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    const link = await screen.findByRole('link', { name: 'API docs (opens in a new tab)' });
    expect(link).toHaveAttribute('href', '/api/docs/');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it.each([
    [401, 'invalid email or password', 'The email address or password is wrong.'],
    [403, 'this account is disabled: ask an admin', 'This account is disabled. Ask an admin.'],
    [
      403,
      'this one-time password has expired: ask an admin for a new one',
      'This one-time password has expired. Ask an admin for a new one.',
    ],
    [429, 'too many attempts, try again later', 'Too many attempts. Try again in a few minutes.'],
  ])('explains a %i (%s)', async (status, error, message) => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => {
        throw statusError(status, error);
      }),
    });
    render(<App api={api} pollMs={0} />);
    await signInWith('ken@example.com', 'x');
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('a locked account reads the time it unlocks, in local time', async () => {
    const until = new Date(Date.now() + 15 * 60_000).toISOString();
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => {
        throw statusError(
          429,
          `too many failed sign-ins for this account: try again after ${until}`,
          {
            lockedUntil: until,
          },
        );
      }),
    });
    render(<App api={api} pollMs={0} />);
    await signInWith('ken@example.com', 'x');
    const time = new Date(until).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Too many failed sign-ins for this account. Try again after ${time}.`,
    );
  });

  it('returns to sign-in when the session ends mid-use', async () => {
    const api = fakeApi();
    render(<App api={api} pollMs={0} />);
    await screen.findByText('No jobs yet: upload a document to start.');
    act(() => api.expireSession());
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Your session has ended');
    expect(status).toHaveTextContent(
      'It expired, an admin disabled the account, or the admin password rotated. Sign in again to continue.',
    );
  });

  it('shows and hides the password', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    const field = await screen.findByLabelText('Password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(field).toHaveAttribute('type', 'text');
    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(hide);
    expect(field).toHaveAttribute('type', 'password');
  });

  it('marks the fields invalid on an error and clears it on edit', async () => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => {
        throw statusError(401, 'invalid email or password');
      }),
    });
    render(<App api={api} pollMs={0} />);
    await signInWith('ken@example.com', 'x');
    await screen.findByRole('alert');
    const field = screen.getByLabelText('Password');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await userEvent.type(field, 'y');
    expect(field).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('needs both fields before Sign in works', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    const button = await screen.findByRole('button', { name: 'Sign in' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Email address'), 'ken@example.com');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    expect(button).toBeEnabled();
  });

  it('offers the colour mode switch and the admin hint before sign-in', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    await screen.findByLabelText('Email address'); // the loading screen has the switch too
    expect(screen.getByRole('group', { name: 'Colour mode' })).toBeInTheDocument();
    expect(screen.getByText(/sign in as/)).toHaveTextContent(
      'Admins: sign in as admin with the token printed in the API log on each restart.',
    );
  });

  it('after failed attempts, says how many once (D9)', async () => {
    const last = new Date(Date.now() - 5 * 60_000).toISOString();
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => signedIn({}, 3, last)),
    });
    render(<App api={api} pollMs={0} />);
    await signInWith('ken@example.com', 'a long phrase here');
    const notice = await screen.findByRole('status', { name: 'Failed sign-ins' });
    expect(notice).toHaveTextContent(
      "3 failed sign-ins since your last visit, the last one 5 min ago. If that wasn't you, tell an admin.",
    );
    await userEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status', { name: 'Failed sign-ins' })).not.toBeInTheDocument();
  });

  it('says "1 failed sign-in" for one', async () => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => signedIn({}, 1, new Date().toISOString())),
    });
    render(<App api={api} pollMs={0} />);
    await signInWith('ken@example.com', 'a long phrase here');
    expect(await screen.findByRole('status', { name: 'Failed sign-ins' })).toHaveTextContent(
      /^1 failed sign-in since your last visit/,
    );
  });

  it('a one-time password leads to the password change, not the app', async () => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => signedIn({ mustChangePassword: true })),
    });
    render(<App api={api} pollMs={0} />);
    await signInWith('ken@example.com', 'abcd-efgh-jkmn-pqrs');
    expect(
      await screen.findByRole('heading', { name: 'Choose your password' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(api.listJobs).not.toHaveBeenCalled();
  });

  it('a session still waiting for the password change opens on it after a reload', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({ ...signedIn({ mustChangePassword: true }) })),
    });
    render(<App api={api} pollMs={0} />);
    expect(
      await screen.findByRole('heading', { name: 'Choose your password' }),
    ).toBeInTheDocument();
  });

  it('signs out', async () => {
    const api = fakeApi();
    render(<App api={api} pollMs={0} />);
    // An admin signs out from the account menu on their name.
    await userEvent.click(
      await screen.findByRole('button', { name: 'admin (admin): account menu' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(api.logout).toHaveBeenCalled();
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
  });

  it('offers Administration to admins only', async () => {
    const { unmount } = render(<App api={fakeApi()} pollMs={0} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'admin (admin): account menu' }),
    );
    expect(screen.getByRole('menuitem', { name: 'Administration' })).toBeInTheDocument();
    unmount();
    const user = fakeApi({ me: vi.fn(async () => signedIn({ label: 'Ken' })) });
    render(<App api={user} pollMs={0} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ken (user): account menu' }));
    expect(screen.queryByRole('menuitem', { name: 'Administration' })).not.toBeInTheDocument();
  });

  it('says the server is unreachable (not "sign in") when the check fails, and retries', async () => {
    const me = vi
      .fn()
      .mockRejectedValueOnce(statusError(502, 'Bad Gateway'))
      .mockResolvedValueOnce({
        role: 'admin',
        label: 'admin',
        email: null,
        mustChangePassword: false,
        userId: 'u-test',
      });
    render(<App api={fakeApi({ me })} pollMs={0} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server");
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No jobs yet: upload a document to start.')).toBeInTheDocument();
  });
});
