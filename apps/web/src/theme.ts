import { useCallback, useState } from 'react';

/** Colour mode (UI handoff): light, dark, or follow the OS. Remembered per browser. */
export type ThemePref = 'light' | 'dark' | 'system';
export const THEME_KEY = 'ih.theme';
const PREFS: readonly ThemePref[] = ['light', 'dark', 'system'];

/** The `data-theme` value for a preference; `system` = no attribute (prefers-color-scheme decides). */
export function themeAttr(pref: ThemePref): 'light' | 'dark' | null {
  return pref === 'system' ? null : pref;
}

export function loadTheme(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return PREFS.includes(stored as ThemePref) ? (stored as ThemePref) : 'system';
  } catch {
    return 'system'; // storage blocked (private window, policy)
  }
}

export function saveTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  const attr = themeAttr(pref);
  if (attr) root.dataset.theme = attr;
  else delete root.dataset.theme;
}

export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(loadTheme);
  const choose = useCallback((next: ThemePref) => {
    applyTheme(next);
    saveTheme(next);
    setPref(next);
  }, []);
  return [pref, choose];
}
