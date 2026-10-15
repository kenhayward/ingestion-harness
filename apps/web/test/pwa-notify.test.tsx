import type { JobSummary } from '@ih/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { InstallPrompt } from '../src/pwa/install.js';
import { LaunchedFiles } from '../src/pwa/launch.js';
import { fakeApi, job } from './fake-api.js';

const ME = 'Ken';
const BELL = 'Notify me when my jobs finish';

/** The browser's Notification, recording what was shown. */
function stubNotifications(permission: NotificationPermission, answer = permission) {
  const shown: FakeNotification[] = [];
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = answer;
      return answer;
    });
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
      readonly title: string,
      readonly options: NotificationOptions,
    ) {
      shown.push(this);
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { shown, Notification: FakeNotification };
}

/** An App whose jobs list answers `lists` in turn (the last one repeats), polling every 20 ms. */
function app(lists: JobSummary[][], role: 'user' | 'admin' = 'user') {
  let call = 0;
  const api = fakeApi({
    me: vi.fn(async () => ({
      role,
      label: ME,
      email: null,
      mustChangePassword: false,
      userId: 'u-test',
    })),
    listJobs: vi.fn(async () => lists[Math.min(call++, lists.length - 1)]!),
  });
  render(
    <App api={api} pollMs={20} launched={new LaunchedFiles()} install={new InstallPrompt()} />,
  );
  return api;
}

const mine = (status: JobSummary['status']) =>
  job({ id: 'a', status, createdBy: ME, filename: 'invoice.pdf' });

beforeEach(() => {
  window.location.hash = '#/jobs';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('the notifications bell', () => {
  it('asks the browser for permission, then turns notifications on and off', async () => {
    const { Notification } = stubNotifications('default', 'granted');
    app([[]]);
    const banner = await screen.findByRole('banner');
    const bell = within(banner).getByRole('button', { name: BELL });
    expect(bell).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(bell);
    expect(Notification.requestPermission).toHaveBeenCalled();
    expect(bell).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('ih.notify')).toBe('1');

    await userEvent.click(bell);
    expect(bell).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('ih.notify')).toBeNull();
  });

  it('stays off when permission is refused', async () => {
    stubNotifications('default', 'denied');
    app([[]]);
    const banner = await screen.findByRole('banner');
    await userEvent.click(within(banner).getByRole('button', { name: BELL }));
    const blocked = within(banner).getByRole('button', { name: 'Notifications are blocked' });
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(blocked).toHaveAttribute('title', expect.stringMatching(/site permissions/));
    expect(localStorage.getItem('ih.notify')).toBeNull();
  });

  it('starts on when it was turned on before and permission still stands', async () => {
    stubNotifications('granted');
    localStorage.setItem('ih.notify', '1');
    app([[]]);
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('button', { name: BELL })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('is not offered where the browser has no notifications', async () => {
    vi.stubGlobal('Notification', undefined);
    app([[]]);
    const banner = await screen.findByRole('banner');
    expect(within(banner).queryByRole('button', { name: BELL })).toBeNull();
  });
});

describe('toasts for your jobs', () => {
  it('shows one when your job is ready while the window is in the background', async () => {
    const { shown } = stubNotifications('granted');
    localStorage.setItem('ih.notify', '1');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    app([[mine('running')], [mine('awaiting_review')]]);

    await waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]!.title).toBe('Ready for review');
    expect(shown[0]!.options).toMatchObject({ body: 'invoice.pdf', tag: 'ct-job-a' });

    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    act(() => shown[0]!.onclick!());
    expect(focus).toHaveBeenCalled();
    expect(window.location.hash).toBe('#/review/a');
    expect(shown[0]!.close).toHaveBeenCalled();
  });

  it('stays quiet while you are looking at the app', async () => {
    const { shown } = stubNotifications('granted');
    localStorage.setItem('ih.notify', '1');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const api = app([[mine('running')], [mine('awaiting_review')]]);
    await waitFor(() => expect(vi.mocked(api.listJobs).mock.calls.length).toBeGreaterThan(3));
    expect(shown).toHaveLength(0);
  });

  it('stays quiet while notifications are off, and for jobs that finished before the page loaded', async () => {
    const { shown } = stubNotifications('granted');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const api = app([[mine('running')], [mine('awaiting_review')]]);
    await waitFor(() => expect(vi.mocked(api.listJobs).mock.calls.length).toBeGreaterThan(3));
    expect(shown).toHaveLength(0);

    // Turned on later: the job that finished meanwhile is not announced.
    await userEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: BELL }));
    const calls = vi.mocked(api.listJobs).mock.calls.length;
    await waitFor(() => expect(vi.mocked(api.listJobs).mock.calls.length).toBeGreaterThan(calls));
    expect(shown).toHaveLength(0);
  });
});

describe('the taskbar badge', () => {
  it('shows how many jobs need attention, and clears at none', async () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    const waiting = [
      job({ id: 'r', status: 'awaiting_review' }),
      job({ id: 'f', status: 'failed' }),
      job({ id: 'q', status: 'queued' }),
    ];
    app([waiting, waiting, []]);
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2));
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
    delete (navigator as { setAppBadge?: unknown }).setAppBadge;
    delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
  });
});
