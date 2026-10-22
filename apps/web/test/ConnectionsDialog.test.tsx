import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ConnectionsLink } from '@ih/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsDialog } from '../src/access/ConnectionsDialog.js';
import { ProfileConnections } from '../src/access/ProfileConnections.js';
import { connectionsModal, embeddable, openConnectionsLink } from '../src/access/connections.js';
import { fakeApi } from './fake-api.js';

const PAGE = 'https://connections.ctstudio.app';
const here = () => window.location.origin;
const link = (code = 'abc', appOrigin = here()): ConnectionsLink => ({
  url: `${PAGE}/connections/start?code=${code}`,
  embed: { appOrigin, pageOrigin: PAGE },
});
const frame = () => screen.getByTitle('Connections') as HTMLIFrameElement;
const post = (data: unknown, over: { origin?: string; source?: MessageEventSource | null } = {}) =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin: over.origin ?? PAGE,
        source: over.source === undefined ? frame().contentWindow : over.source,
      }),
    );
  });

beforeEach(() => connectionsModal.reset());
afterEach(() => vi.unstubAllGlobals());

describe('where Manage connections opens the page', () => {
  it('in a modal only when the link may be framed by this very origin, unframed', () => {
    const win = {
      location: { origin: 'https://ctstudio.app' },
      top: null as unknown,
      self: null as unknown,
    };
    win.top = win;
    win.self = win;
    const w = win as unknown as Window;
    expect(embeddable(link('a', 'https://ctstudio.app'), w)).toBe(true);
    expect(embeddable({ ...link(), embed: null }, w)).toBe(false);
    expect(embeddable(link('a', 'http://10.0.0.5:8081'), w)).toBe(false);
    const framed = { ...win, top: {} } as unknown as Window;
    expect(embeddable(link('a', 'https://ctstudio.app'), framed)).toBe(false);
  });

  it('opens a modal when embedded', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    openConnectionsLink(link());
    expect(open).not.toHaveBeenCalled();
    expect(connectionsModal.state().link).toEqual(link());
  });

  it('opens a tab without embed, or on another origin', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    openConnectionsLink({ ...link(), embed: null });
    openConnectionsLink(link('b', 'https://elsewhere.example'));
    expect(open).toHaveBeenNthCalledWith(1, link().url, '_blank', 'noopener');
    expect(open).toHaveBeenNthCalledWith(2, link('b').url, '_blank', 'noopener');
    expect(connectionsModal.state().link).toBeNull();
  });
});

describe('ConnectionsDialog', () => {
  const show = () => {
    const api = fakeApi({ connectionsLink: vi.fn(async () => link('again')) });
    render(<ConnectionsDialog api={api} />);
    act(() => connectionsModal.show(link()));
    return api;
  };

  it('shows nothing until opened', () => {
    render(<ConnectionsDialog api={fakeApi()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('frames the page, sandboxed and without a referrer', () => {
    show();
    expect(screen.getByRole('dialog', { name: 'Connections' })).toBeTruthy();
    const f = frame();
    expect(f.getAttribute('src')).toBe(link().url);
    expect(f.getAttribute('sandbox')).toBe('allow-forms allow-scripts allow-same-origin');
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('refreshes on connections-changed from its frame', () => {
    show();
    const before = connectionsModal.state().version;
    post({ source: 'ct-bridge', type: 'connections-changed' });
    expect(connectionsModal.state().version).toBe(before + 1);
  });

  it('ignores messages not from its frame', () => {
    show();
    const before = connectionsModal.state().version;
    post({ source: 'ct-bridge', type: 'connections-changed' }, { origin: 'https://evil.example' });
    post({ source: 'ct-bridge', type: 'connections-changed' }, { source: window });
    post({ source: 'other', type: 'connections-changed' });
    post('connections-changed');
    expect(connectionsModal.state().version).toBe(before);
    expect(screen.queryByText('Your session ended')).toBeNull();
  });

  it('reopens after session-ended', async () => {
    const api = show();
    post({ source: 'ct-bridge', type: 'session-ended' });
    expect(screen.getByText('Your session ended')).toBeTruthy();
    expect(screen.queryByTitle('Connections')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    });
    expect(api.connectionsLink).toHaveBeenCalledOnce();
    expect(frame().getAttribute('src')).toBe(link('again').url);
  });

  it('closes by its Close button, not by a click outside', () => {
    show();
    fireEvent.click(document.querySelector('.dialog-backdrop')!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe("CT Studio's own lists of connections", () => {
  it('Profile reads them again when the page says they changed', async () => {
    const api = fakeApi();
    render(<ProfileConnections api={api} />);
    await act(async () => {});
    expect(api.listMyConnections).toHaveBeenCalledTimes(1);
    await act(async () => connectionsModal.changed());
    expect(api.listMyConnections).toHaveBeenCalledTimes(2);
  });
});
