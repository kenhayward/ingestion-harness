import { useSyncExternalStore } from 'react';
import type { ConnectionsLink } from '@ih/shared';

/**
 * Where the delivery bridge's connections page is open (ADR 0017): in CT Studio's modal when the
 * page has its own origin and may be framed by this one, else in a new tab. Also the version
 * CT Studio's own lists of connections re-read on, bumped when the framed page says something
 * changed.
 */
export interface ConnectionsModalState {
  /** The link the modal frames; null: closed. */
  link: ConnectionsLink | null;
  /** The page said its session ended: the modal offers to open it again. */
  ended: boolean;
  version: number;
}

const INITIAL: ConnectionsModalState = { link: null, ended: false, version: 0 };
let state = INITIAL;
const listeners = new Set<() => void>();
const set = (next: Partial<ConnectionsModalState>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

export const connectionsModal = {
  state: () => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  show: (link: ConnectionsLink) => set({ link, ended: false }),
  ended: () => set({ ended: true }),
  close: () => set({ link: null, ended: false }),
  changed: () => set({ version: state.version + 1 }),
  /** Tests only: closed, version 0. */
  reset: () => set(INITIAL),
};

/**
 * Whether the page may open in the modal: the bridge allows framing by an origin, it is this
 * window's (someone on another address, e.g. the LAN one, would be refused by the page's CSP),
 * and this window is not itself framed (the page's frame-ancestors and its cookie would fail).
 */
export function embeddable(link: ConnectionsLink, win: Window = window): boolean {
  return !!link.embed && win.location.origin === link.embed.appOrigin && win.top === win.self;
}

/** Opens the page: the modal when it may be framed here, else a tab without an opener. */
export function openConnectionsLink(link: ConnectionsLink, win: Window = window): void {
  if (embeddable(link, win)) connectionsModal.show(link);
  else win.open(link.url, '_blank', 'noopener');
}

/** What a message from the framed page says; null for anything else (another origin or window). */
export function pageMessage(
  e: MessageEvent,
  link: ConnectionsLink,
  frame: Window | null,
): 'connections-changed' | 'session-ended' | null {
  if (!link.embed || e.origin !== link.embed.pageOrigin || !frame || e.source !== frame) {
    return null;
  }
  const data = e.data as { source?: unknown; type?: unknown } | null;
  if (typeof data !== 'object' || data === null || data.source !== 'ct-bridge') return null;
  return data.type === 'connections-changed' || data.type === 'session-ended' ? data.type : null;
}

export function useConnectionsModal(): ConnectionsModalState {
  return useSyncExternalStore(connectionsModal.subscribe, connectionsModal.state);
}

/** Bumped when connections changed on the bridge's page: add it to a fetch's dependencies. */
export function useConnectionsVersion(): number {
  return useConnectionsModal().version;
}
