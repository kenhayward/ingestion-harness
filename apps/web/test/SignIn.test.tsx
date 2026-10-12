import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { fakeApi } from './fake-api.js';

const statusError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

describe('sign-in gate', () => {
  it('asks for a token when not signed in, then shows the app', async () => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => ({ role: 'user' as const, label: 'Ken – laptop', expiresAt: null })),
    });
    render(<App api={api} pollMs={0} />);
    const field = await screen.findByLabelText('Access token');
    expect(field).toHaveAttribute('type', 'password');
    await userEvent.type(field, 'ih_abc');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(api.login).toHaveBeenCalledWith('ih_abc');
    expect(await screen.findByText('No jobs yet.')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Signed in as Ken – laptop (user)' }),
    ).toBeInTheDocument();
  });

  it.each([
    [401, 'That token is invalid or has expired.'],
    [429, 'Too many attempts. Try again in a few minutes.'],
  ])('explains a %i', async (status, message) => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => {
        throw statusError(status, 'nope');
      }),
    });
    render(<App api={api} pollMs={0} />);
    await userEvent.type(await screen.findByLabelText('Access token'), 'ih_x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('returns to sign-in when the session ends mid-use', async () => {
    const api = fakeApi();
    render(<App api={api} pollMs={0} />);
    await screen.findByText('No jobs yet.');
    act(() => api.expireSession());
    expect(await screen.findByLabelText('Access token')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your session has ended.');
  });

  it('signs out', async () => {
    const api = fakeApi();
    render(<App api={api} pollMs={0} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(api.logout).toHaveBeenCalled();
    expect(await screen.findByLabelText('Access token')).toBeInTheDocument();
  });

  it('shows the Access link to admins only', async () => {
    const { unmount } = render(<App api={fakeApi()} pollMs={0} />);
    expect(await screen.findByRole('link', { name: 'Access' })).toHaveAttribute('href', '#/access');
    expect(screen.getByRole('group', { name: 'Signed in as admin (admin)' })).toBeInTheDocument();
    unmount();
    const user = fakeApi({
      me: vi.fn(async () => ({ role: 'user' as const, label: 'Ken', expiresAt: null })),
    });
    render(<App api={user} pollMs={0} />);
    await screen.findByRole('group', { name: 'Signed in as Ken (user)' });
    expect(screen.queryByRole('link', { name: 'Access' })).not.toBeInTheDocument();
  });

  it('says the server is unreachable (not "sign in") when the check fails, and retries', async () => {
    const me = vi
      .fn()
      .mockRejectedValueOnce(statusError(502, 'Bad Gateway'))
      .mockResolvedValueOnce({ role: 'admin', label: 'admin', expiresAt: null });
    render(<App api={fakeApi({ me })} pollMs={0} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server");
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No jobs yet.')).toBeInTheDocument();
  });
});
