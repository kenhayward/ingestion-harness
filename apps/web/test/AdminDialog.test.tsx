import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminDialog } from '../src/access/AdminDialog.js';
import { fakeApi } from './fake-api.js';

const admin = {
  role: 'admin' as const,
  label: 'Ken',
  email: null,
  mustChangePassword: false,
  userId: 'u-test',
};

function open(onClose = vi.fn()) {
  const { unmount } = render(<AdminDialog api={fakeApi()} me={admin} onClose={onClose} />);
  return { dialog: screen.getByRole('dialog', { name: 'Administration' }), onClose, unmount };
}

const header = (dialog: HTMLElement) => dialog.querySelector('header')!;

describe('AdminDialog', () => {
  afterEach(() => localStorage.removeItem('ih.adminTab'));

  it('opens on Models, with Add endpoint in the header', async () => {
    const { dialog } = open();
    const tabs = within(dialog).getByRole('tablist', { name: 'Administration sections' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual([
      'Models',
      'Linked data',
      'Published outputs',
      'Users',
      'Integration',
      'Maintenance',
    ]);
    expect(within(tabs).getByRole('tab', { name: 'Models' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(dialog).getByRole('tabpanel')).toHaveAccessibleName('Models');
    expect(
      await within(header(dialog)).findByRole('button', { name: 'Add endpoint' }),
    ).toBeInTheDocument();
    // The page's own heading is gone: the dialog's title names the tab.
    expect(within(dialog).queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('switches tabs, and the header action with them', async () => {
    const { dialog } = open();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Linked data' }));
    expect(within(dialog).getByRole('tabpanel')).toHaveAccessibleName('Linked data');
    // Linked data has no main button: only its help.
    expect(
      within(header(dialog))
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Help: Linked data settings']);
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Users' }));
    expect(
      await within(header(dialog)).findByRole('button', { name: 'Add user' }),
    ).toBeInTheDocument();
    expect(await within(dialog).findByRole('table', { name: 'Users' })).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys', async () => {
    const { dialog } = open();
    within(dialog).getByRole('tab', { name: 'Models' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(within(dialog).getByRole('tab', { name: 'Linked data' })).toHaveFocus();
    // Up from the first tab wraps to the last.
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(within(dialog).getByRole('tab', { name: 'Maintenance' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('keeps users on the Users tab and S3 keys on Integration', async () => {
    const { dialog } = open();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Users' }));
    expect(await within(dialog).findByRole('table', { name: 'Users' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Data lake S3 keys' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Integration' }));
    expect(within(dialog).getByRole('tabpanel')).toHaveAccessibleName('Integration');
    expect(
      await within(dialog).findByRole('heading', { name: 'Data lake S3 keys' }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('table', { name: 'Users' })).toBeNull();
    expect(within(header(dialog)).queryByRole('button')).toBeNull();
  });

  it.each([
    ['Models', 'Models and model choices', 'Add endpoint'],
    ['Linked data', 'Linked data settings', null],
    ['Published outputs', 'How publishing targets work', 'Add target'],
    ['Users', 'Users and sign-in', 'Add user'],
  ])('the %s tab has its help last in the header', async (tab, title, main) => {
    const { dialog } = open();
    await userEvent.click(within(dialog).getByRole('tab', { name: tab }));
    if (main) await within(header(dialog)).findByRole('button', { name: main });
    const buttons = within(header(dialog)).getAllByRole('button');
    const help = within(header(dialog)).getByRole('button', { name: `Help: ${title}` });
    expect(buttons.at(-1)).toBe(help);
    await userEvent.click(help);
    expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
  });

  it('opens a remembered Access tab as Users', () => {
    localStorage.setItem('ih.adminTab', 'access');
    const { dialog } = open();
    expect(within(dialog).getByRole('tab', { name: 'Users' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('remembers the last tab in this browser', async () => {
    const first = open();
    await userEvent.click(within(first.dialog).getByRole('tab', { name: 'Users' }));
    expect(localStorage.getItem('ih.adminTab')).toBe('users');
    first.unmount();
    const { dialog } = open();
    expect(within(dialog).getByRole('tab', { name: 'Users' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('closes only with Close: not Escape, not a click outside', async () => {
    const { dialog, onClose } = open();
    await userEvent.keyboard('{Escape}');
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens Add user above it, and Escape closes only that', async () => {
    const { dialog, onClose } = open();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Users' }));
    await userEvent.click(await within(header(dialog)).findByRole('button', { name: 'Add user' }));
    expect(screen.getByRole('dialog', { name: 'Add user' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Add user' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Administration' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
