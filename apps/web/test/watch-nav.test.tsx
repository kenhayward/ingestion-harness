import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { fakeApi } from './fake-api.js';

afterEach(() => {
  window.location.hash = '';
});

function as(
  role: 'admin' | 'designer' | 'operator',
  overrides: Parameters<typeof fakeApi>[0] = {},
) {
  return fakeApi({
    me: vi.fn(async () => ({
      role,
      label: 'Sam',
      email: 'sam@example.com',
      mustChangePassword: false,
      userId: 'u-test',
    })),
    ...overrides,
  });
}

describe('the Watched folders nav item', () => {
  it('is for admins, badged with the watches that have a problem', async () => {
    const api = as('admin', { getWatchProblems: vi.fn(async () => ({ count: 2 })) });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const link = within(nav).getByRole('link', { name: /^Watched folders/ });
    expect(link).toHaveAttribute('href', '#/watched-folders');
    expect(await within(link).findByText('2 have a problem')).toBeInTheDocument();
  });

  it('shows no badge when no watch has a problem', async () => {
    render(<App api={as('admin')} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Watched folders' })).toBeInTheDocument();
  });

  it.each(['designer', 'operator'] as const)('is not offered to a %s', async (role) => {
    const api = as(role);
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: /Watched folders/ })).toBeNull();
    expect(api.getWatchProblems).not.toHaveBeenCalled();
  });

  it('opens the page for an admin and keeps a designer out', async () => {
    window.location.hash = '#/watched-folders';
    const { unmount } = render(<App api={as('admin')} pollMs={0} />);
    expect(await screen.findByRole('heading', { name: 'Watched folders' })).toBeInTheDocument();
    unmount();
    render(<App api={as('designer')} pollMs={0} />);
    expect(await screen.findByRole('heading', { name: 'Not available' })).toBeInTheDocument();
  });
});
