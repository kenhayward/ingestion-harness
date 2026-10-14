type ServiceWorkerNav = {
  serviceWorker?: { register(url: string, options: { scope: string }): Promise<unknown> };
};

/**
 * Registers public/sw.js (docs/design/pwa.md: an offline page, nothing else cached) in
 * production builds, after the page has loaded so it never competes with the first render.
 */
export function registerServiceWorker({
  nav = navigator as ServiceWorkerNav,
  win = window as EventTarget,
  enabled = import.meta.env.PROD,
  loaded = document.readyState === 'complete',
}: {
  nav?: ServiceWorkerNav;
  win?: EventTarget;
  enabled?: boolean;
  loaded?: boolean;
} = {}): void {
  const sw = nav.serviceWorker;
  if (!enabled || !sw) return;
  const register = () => {
    // A worker that fails to register only costs the offline page.
    sw.register('/sw.js', { scope: '/' }).catch(() => {});
  };
  if (loaded) register();
  else win.addEventListener('load', register, { once: true });
}
