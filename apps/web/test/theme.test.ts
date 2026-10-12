import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, loadTheme, saveTheme, themeAttr, THEME_KEY, useTheme } from '../src/theme.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

describe('themeAttr', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', null],
  ] as const)('%s → %s', (pref, attr) => expect(themeAttr(pref)).toBe(attr));
});

describe('loadTheme / saveTheme', () => {
  it.each([
    [null, 'system'],
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
    ['purple', 'system'],
  ])('stored %s → %s', (stored, pref) => {
    if (stored !== null) localStorage.setItem(THEME_KEY, stored);
    expect(loadTheme()).toBe(pref);
  });

  it('round-trips through ih.theme', () => {
    saveTheme('dark');
    expect(localStorage.getItem('ih.theme')).toBe('dark');
  });

  it('falls back to system when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadTheme()).toBe('system');
    expect(() => saveTheme('dark')).not.toThrow();
  });
});

describe('applyTheme', () => {
  it('sets and clears data-theme', () => {
    applyTheme('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    applyTheme('system');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });
});

describe('useTheme', () => {
  it('starts from storage, applies and persists changes', () => {
    localStorage.setItem(THEME_KEY, 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('light');
    act(() => result.current[1]('dark'));
    expect(result.current[0]).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  it('still switches for the session when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTheme());
    act(() => result.current[1]('light'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });
});
