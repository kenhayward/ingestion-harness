/**
 * Launches of the installed app (docs/design/pwa.md): files opened with CT Studio from Explorer
 * (the manifest's `file_handlers`) and taskbar shortcuts that reuse the open window
 * (`launch_handler: focus-existing`). Chromium hands both to `window.launchQueue`.
 */

export type LaunchParams = {
  readonly files: readonly { getFile(): Promise<File> }[];
  readonly targetURL?: string;
};
export type LaunchQueue = { setConsumer(consumer: (params: LaunchParams) => void): void };

/**
 * Files opened with the app, kept until the upload strip takes them: a launch can come before
 * sign-in or while another page is open.
 */
export class LaunchedFiles {
  private files: File[] = [];
  private readonly listeners = new Set<() => void>();

  push(files: readonly File[]): void {
    if (!files.length) return;
    this.files.push(...files);
    for (const listener of this.listeners) listener();
  }

  /** Every waiting file, once: the store is empty afterwards. */
  take(): File[] {
    const files = this.files;
    this.files = [];
    return files;
  }

  get waiting(): boolean {
    return this.files.length > 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** The app's launched files (main.tsx fills it; App takes it as a prop for tests). */
export const launchedFiles = new LaunchedFiles();

/**
 * Feeds launches into `store`. A launch without files is a shortcut reusing the open window:
 * the window is not navigated by the browser, so go to the shortcut's page here.
 */
export function consumeLaunches(
  queue: LaunchQueue | undefined,
  store: LaunchedFiles,
  go: (hash: string) => void,
): void {
  queue?.setConsumer((params) => {
    if (params.files.length) {
      void Promise.all(params.files.map((f) => f.getFile())).then(
        (files) => store.push(files),
        () => {}, // the file went away or access was refused: nothing to upload
      );
      return;
    }
    const hash = params.targetURL ? new URL(params.targetURL).hash : '';
    if (hash) go(hash);
  });
}

/** Go to `hash`; the same hash again is announced too, so a repeated shortcut still acts. */
export function goTo(hash: string): void {
  if (window.location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else window.location.hash = hash;
}
