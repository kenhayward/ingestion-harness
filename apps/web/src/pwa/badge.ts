import { useEffect } from 'react';

type BadgeNav = {
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * The installed app's taskbar badge (docs/design/pwa.md): `count` jobs need someone, the same
 * number as the nav's Jobs badge. A browser tab has no badge, and an unsupported browser no API;
 * both are ignored. Cleared when the app signs out.
 */
export function useAppBadge(count: number, nav: BadgeNav = navigator as BadgeNav): void {
  useEffect(() => {
    const set = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    set?.catch(() => {});
  }, [count, nav]);
  useEffect(() => () => void nav.clearAppBadge?.().catch(() => {}), [nav]);
}
