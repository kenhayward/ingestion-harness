import { useSyncExternalStore } from 'react';

/** Chromium's `beforeinstallprompt` event (not in the DOM typings). */
type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/**
 * The browser's offer to install the app (docs/design/pwa.md). Edge and Chrome fire
 * `beforeinstallprompt` while the app can be installed and is not; the event can come before
 * React renders, so main.tsx creates this first. An offer can be shown once.
 */
export class InstallPrompt {
  private offer: InstallPromptEvent | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(target: EventTarget = new EventTarget()) {
    target.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // no mini-infobar: the top bar offers Install CT Studio
      this.set(e as InstallPromptEvent);
    });
    target.addEventListener('appinstalled', () => this.set(null));
  }

  get available(): boolean {
    return this.offer !== null;
  }

  /** Shows the browser's install dialog. */
  async install(): Promise<InstallOutcome> {
    const offer = this.offer;
    if (!offer) return 'unavailable';
    this.set(null);
    await offer.prompt();
    return (await offer.userChoice).outcome;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(offer: InstallPromptEvent | null) {
    this.offer = offer;
    for (const listener of this.listeners) listener();
  }
}

/** The app's install offer (main.tsx creates it on the window; App takes it as a prop for tests). */
export const installPrompt = new InstallPrompt(typeof window === 'undefined' ? undefined : window);

/** Whether `prompt` can show the install dialog now. */
export function useInstallAvailable(prompt: InstallPrompt): boolean {
  return useSyncExternalStore(prompt.subscribe, () => prompt.available);
}
