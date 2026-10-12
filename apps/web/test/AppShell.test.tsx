import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { fakeApi, job } from './fake-api.js';

const SEARCH = 'Search jobs, results and document types';

afterEach(() => {
  window.location.hash = '';
});

describe('app shell', () => {
  it('has a top bar with search, colour mode, Upload PDF and the signed-in token', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({ role: 'user' as const, label: 'Ken – laptop', expiresAt: null })),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('searchbox', { name: SEARCH })).toBeInTheDocument();
    expect(within(banner).getByRole('group', { name: 'Colour mode' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Upload PDF' })).toBeInTheDocument();
    expect(
      within(banner).getByRole('group', { name: 'Signed in as Ken – laptop (user)' }),
    ).toHaveTextContent('KL');
    expect(within(banner).getByRole('link', { name: 'Ingestion Harness' })).toHaveAttribute(
      'href',
      '#/',
    );
  });

  it('badges Jobs with the number of jobs needing attention', async () => {
    const api = fakeApi({
      listJobs: vi.fn(async () =>
        (['awaiting_review', 'failed', 'running', 'succeeded'] as const).map((status) =>
          job({ status }),
        ),
      ),
    });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(await within(nav).findByText('2 need attention')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /^Jobs/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('shows no badge when nothing needs attention', async () => {
    render(
      <App
        api={fakeApi({ listJobs: vi.fn(async () => [job({ status: 'succeeded' })]) })}
        pollMs={0}
      />,
    );
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await screen.findByText('invoice.pdf');
    expect(within(nav).queryByText(/need attention/)).not.toBeInTheDocument();
  });

  it('marks the parent page current on child screens', async () => {
    window.location.hash = '#/templates/x/1';
    render(<App api={fakeApi()} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Document types' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: /^Jobs/ })).not.toHaveAttribute('aria-current');
  });

  it('focuses search on Ctrl+K, not on a plain k, and Escape clears it', async () => {
    render(<App api={fakeApi()} pollMs={0} />);
    const search = await screen.findByRole('searchbox', { name: SEARCH });
    await userEvent.keyboard('k');
    expect(search).not.toHaveFocus();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(search).toHaveFocus();
    await userEvent.type(search, 'acme');
    expect(search).toHaveValue('acme');
    await userEvent.keyboard('{Escape}');
    expect(search).toHaveValue('');
  });
});
