import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPO_URL } from '@ih/shared';
import { AboutDialog } from '../src/about/AboutDialog.js';
import { releaseNotesFrom } from '../src/about/releaseNotes.js';

const tagged = { version: '2026.10.18.7', previous: '2026.10.18.6', commit: 'abc1234' };

const note = (title: string) => `<!doctype html><html><head><style>body{}</style></head><body>
  <main><h1>${title}</h1>
    <nav id="contents"><a href="#detail">Detail</a></nav>
    <h2 id="detail">Detail of ${title}</h2>
  </main></body></html>`;

const notes = releaseNotesFrom({
  'Release-Notes-20261001.html': () => Promise.resolve(note('October first')),
  'Release-Notes-20261018.html': () => Promise.resolve(note('October eighteenth')),
  'Release-Notes-20260915.html': () => Promise.reject(new Error('gone')),
});

afterEach(() => {
  window.location.hash = '';
});

describe('AboutDialog', () => {
  it('shows the version under the app name and the latest note first', async () => {
    render(<AboutDialog notes={notes} version={tagged} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'About' });
    expect(within(dialog).getByText('CT Studio')).toBeInTheDocument();
    expect(within(dialog).getByText('v2026.10.18.7')).toBeInTheDocument();
    const menu = within(dialog).getByRole('navigation', { name: 'Release notes' });
    expect(
      within(menu)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['18 October 2026', '1 October 2026', '15 September 2026']);
    expect(within(menu).getByRole('button', { name: '18 October 2026' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await within(dialog).findByRole('heading', { name: 'October eighteenth' }));
    expect(within(dialog).getByText('/ Release notes · 18 October 2026')).toBeInTheDocument();
  });

  it('puts the focus on the open note’s date', () => {
    render(<AboutDialog notes={notes} note="2026-10-01" version={tagged} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: '1 October 2026' })).toHaveFocus();
  });

  it('links the build to GitHub', () => {
    render(<AboutDialog notes={notes} version={tagged} onClose={vi.fn()} />);
    const link = screen.getByRole('link', {
      name: 'View this build on GitHub (opens in a new tab)',
    });
    expect(link).toHaveAttribute('href', `${REPO_URL}/releases/tag/2026.10.18.7`);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('has no GitHub link for a dev build', () => {
    render(
      <AboutDialog
        notes={notes}
        version={{ version: 'dev', previous: null, commit: 'unknown' }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('dev')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /GitHub/ })).toBeNull();
  });

  it('shows the note picked on the left', async () => {
    render(<AboutDialog notes={notes} version={tagged} onClose={vi.fn()} />);
    await screen.findByRole('heading', { name: 'October eighteenth' });
    await userEvent.click(screen.getByRole('button', { name: '1 October 2026' }));
    expect(await screen.findByRole('heading', { name: 'October first' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'October eighteenth' })).toBeNull();
    expect(screen.getByRole('button', { name: '1 October 2026' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens on a given note', async () => {
    render(<AboutDialog notes={notes} note="2026-10-01" version={tagged} onClose={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'October first' })).toBeInTheDocument();
  });

  it('says when a note cannot be loaded', async () => {
    render(<AboutDialog notes={notes} note="2026-09-15" version={tagged} onClose={vi.fn()} />);
    expect(await screen.findByText('This release note could not be loaded.')).toBeInTheDocument();
  });

  it('moves through the dates with the arrow keys', async () => {
    render(<AboutDialog notes={notes} version={tagged} onClose={vi.fn()} />);
    await screen.findByRole('heading', { name: 'October eighteenth' });
    screen.getByRole('button', { name: '18 October 2026' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(await screen.findByRole('heading', { name: 'October first' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 October 2026' })).toHaveFocus();
  });

  it('follows a link within the note by scrolling, never changing the address', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<AboutDialog notes={notes} version={tagged} onClose={vi.fn()} />);
    await screen.findByRole('heading', { name: 'October eighteenth' });
    await userEvent.click(screen.getByRole('link', { name: 'Detail' }));
    expect(window.location.hash).toBe('');
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts[0]).toBe(
      screen.getByRole('heading', { name: 'Detail of October eighteenth' }),
    );
  });

  it('closes on Close and on Escape', async () => {
    const onClose = vi.fn();
    render(<AboutDialog notes={notes} version={tagged} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('says so when there are no release notes', () => {
    render(<AboutDialog notes={[]} version={tagged} onClose={vi.fn()} />);
    expect(screen.getByText('No release notes yet.')).toBeInTheDocument();
  });
});
