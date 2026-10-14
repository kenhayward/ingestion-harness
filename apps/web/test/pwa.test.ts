import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallPrompt } from '../src/pwa/install.js';
import { consumeLaunches, goTo, LaunchedFiles, type LaunchParams } from '../src/pwa/launch.js';
import { registerServiceWorker } from '../src/pwa/register.js';

const pdf = new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' });
const docx = new File(['PK'], 'letter.docx');
const handle = (file: File) => ({ getFile: async () => file });

/** A launch queue like Chromium's: the consumer gets each launch once set. */
function fakeQueue() {
  let consumer: ((p: LaunchParams) => void) | undefined;
  return {
    queue: { setConsumer: (fn: (p: LaunchParams) => void) => (consumer = fn) },
    launch: (p: LaunchParams) => consumer!(p),
  };
}

describe('launched files', () => {
  it('holds files until something takes them, then hands each over once', () => {
    const store = new LaunchedFiles();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.push([pdf]);
    store.push([docx]);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(store.take()).toEqual([pdf, docx]);
    expect(store.take()).toEqual([]);
    off();
    store.push([pdf]);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('ignores an empty push', () => {
    const store = new LaunchedFiles();
    const seen = vi.fn();
    store.subscribe(seen);
    store.push([]);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('consumeLaunches (Open with CT Studio, taskbar shortcuts)', () => {
  it('reads the opened files into the store', async () => {
    const { queue, launch } = fakeQueue();
    const store = new LaunchedFiles();
    const go = vi.fn();
    consumeLaunches(queue, store, go);
    launch({ files: [handle(pdf), handle(docx)], targetURL: 'https://ct.example/' });
    await vi.waitFor(() => expect(store.take()).toEqual([pdf, docx]));
    expect(go).not.toHaveBeenCalled();
  });

  it("goes to a shortcut's page when the open window is reused", () => {
    const { queue, launch } = fakeQueue();
    const go = vi.fn();
    consumeLaunches(queue, new LaunchedFiles(), go);
    launch({ files: [], targetURL: 'https://ct.example/#/jobs' });
    expect(go).toHaveBeenCalledWith('#/jobs');
  });

  it('stays put for a plain launch', () => {
    const { queue, launch } = fakeQueue();
    const go = vi.fn();
    consumeLaunches(queue, new LaunchedFiles(), go);
    launch({ files: [], targetURL: 'https://ct.example/' });
    launch({ files: [] });
    expect(go).not.toHaveBeenCalled();
  });

  it('does nothing in a browser without a launch queue', () => {
    expect(() => consumeLaunches(undefined, new LaunchedFiles(), vi.fn())).not.toThrow();
  });
});

describe('goTo', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('changes the hash', () => {
    goTo('#/jobs');
    expect(window.location.hash).toBe('#/jobs');
  });

  it('announces the same hash again, so a repeated shortcut still acts', () => {
    window.location.hash = '#/upload';
    const seen = vi.fn();
    window.addEventListener('hashchange', seen);
    goTo('#/upload');
    window.removeEventListener('hashchange', seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

/** Chromium's beforeinstallprompt event. */
function promptEvent(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  return Object.assign(event, {
    prompt: vi.fn(async () => {}),
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  });
}

describe('InstallPrompt', () => {
  it('is unavailable until the browser offers install', async () => {
    const install = new InstallPrompt(new EventTarget());
    expect(install.available).toBe(false);
    expect(await install.install()).toBe('unavailable');
  });

  it("keeps the browser's offer and shows it on request", async () => {
    const target = new EventTarget();
    const install = new InstallPrompt(target);
    const seen = vi.fn();
    install.subscribe(seen);
    const event = promptEvent('accepted');
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); // no mini-infobar: the app offers its own button
    expect(install.available).toBe(true);
    expect(seen).toHaveBeenCalled();
    expect(await install.install()).toBe('accepted');
    expect(event.prompt).toHaveBeenCalled();
    expect(install.available).toBe(false); // an offer can be shown once
  });

  it('forgets the offer once the app is installed', () => {
    const target = new EventTarget();
    const install = new InstallPrompt(target);
    target.dispatchEvent(promptEvent('dismissed'));
    target.dispatchEvent(new Event('appinstalled'));
    expect(install.available).toBe(false);
  });
});

describe('registerServiceWorker', () => {
  const nav = () => ({ serviceWorker: { register: vi.fn(async () => ({})) } });

  it('registers /sw.js for the whole app once the page has loaded', () => {
    const n = nav();
    const win = new EventTarget();
    registerServiceWorker({ nav: n, win, enabled: true, loaded: false });
    expect(n.serviceWorker.register).not.toHaveBeenCalled();
    win.dispatchEvent(new Event('load'));
    expect(n.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('registers at once when the page has already loaded', () => {
    const n = nav();
    registerServiceWorker({ nav: n, win: new EventTarget(), enabled: true, loaded: true });
    expect(n.serviceWorker.register).toHaveBeenCalledTimes(1);
  });

  it('stays out of development builds', () => {
    const n = nav();
    registerServiceWorker({ nav: n, win: new EventTarget(), enabled: false, loaded: true });
    expect(n.serviceWorker.register).not.toHaveBeenCalled();
  });

  it('does nothing where service workers are unsupported', () => {
    expect(() =>
      registerServiceWorker({ nav: {}, win: new EventTarget(), enabled: true, loaded: true }),
    ).not.toThrow();
  });
});
