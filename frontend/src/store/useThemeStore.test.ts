import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../constants/storage';
import { createMatchMedia } from '../test/utils';
import { useIsDarkMode, useTheme, useThemePreference, useThemeStore } from './useThemeStore';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const LIGHT_CHROME = '#f6f5fb';
const DARK_CHROME = '#0b0a12';

// The store subscribes to OS theme changes once, while it is imported, on the baseline
// matchMedia installed by the global setup. Capture that listener before clearMocks wipes it.
const baselineMatchMedia = window.matchMedia as unknown as ReturnType<typeof createMatchMedia>;
const osThemeListeners = baselineMatchMedia.mock.results
  .map(({ value }) => value as ReturnType<typeof baselineMatchMedia>)
  .filter((list) => list.media === DARK_QUERY)
  .flatMap((list) => list.addEventListener.mock.calls)
  .filter(([type]) => type === 'change')
  .map(([, listener]) => listener as () => void);

const store = () => useThemeStore.getState();
const dataTheme = () => document.documentElement.getAttribute('data-theme');
const themeColors = () =>
  Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((meta) =>
    meta.getAttribute('content')
  );

const prefersDark = (dark: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    createMatchMedia((query) => dark && query === DARK_QUERY)
  );

const switchOsTheme = (dark: boolean) => {
  prefersDark(dark);
  act(() => osThemeListeners.forEach((listener) => listener()));
};

describe('useThemeStore', () => {
  beforeEach(() => {
    // index.html ships one theme-color meta per color scheme
    document.head.innerHTML = `
      <meta name="theme-color" media="(prefers-color-scheme: light)" content="#000000">
      <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">
    `;
  });

  it('follows the system theme by default', () => {
    expect(store()).toMatchObject({ theme: 'system', resolvedTheme: 'light', isDark: false });
  });

  describe('setTheme', () => {
    it('applies dark mode to the document and the browser chrome', () => {
      store().setTheme('dark');

      expect(store()).toMatchObject({ theme: 'dark', resolvedTheme: 'dark', isDark: true });
      expect(dataTheme()).toBe('dark');
      expect(themeColors()).toEqual([DARK_CHROME, DARK_CHROME]);
    });

    it('applies light mode by removing the dark marker', () => {
      store().setTheme('dark');
      store().setTheme('light');

      expect(store()).toMatchObject({ theme: 'light', resolvedTheme: 'light', isDark: false });
      expect(dataTheme()).toBeNull();
      expect(themeColors()).toEqual([LIGHT_CHROME, LIGHT_CHROME]);
    });

    it('resolves "system" from the OS preference', () => {
      prefersDark(true);

      store().setTheme('system');

      expect(store()).toMatchObject({ theme: 'system', resolvedTheme: 'dark', isDark: true });
      expect(dataTheme()).toBe('dark');
    });

    it('persists only the preference', () => {
      store().setTheme('dark');

      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.THEME) ?? 'null')).toEqual({
        state: { theme: 'dark' },
        version: 0,
      });
    });
  });

  describe('toggleTheme', () => {
    it.each([
      ['light', 'light', 'dark'],
      ['dark', 'dark', 'light'],
      ['system', 'dark', 'light'],
      ['system', 'light', 'dark'],
    ] as const)('switches a %s preference (showing %s) to %s', (theme, resolvedTheme, expected) => {
      useThemeStore.setState({ theme, resolvedTheme, isDark: resolvedTheme === 'dark' });

      store().toggleTheme();

      expect(store()).toMatchObject({
        theme: expected,
        resolvedTheme: expected,
        isDark: expected === 'dark',
      });
      expect(dataTheme()).toBe(expected === 'dark' ? 'dark' : null);
    });
  });

  describe('initializeTheme', () => {
    it('applies the saved preference to the document', () => {
      useThemeStore.setState({ theme: 'dark', resolvedTheme: 'light', isDark: false });

      store().initializeTheme();

      expect(store()).toMatchObject({ theme: 'dark', resolvedTheme: 'dark', isDark: true });
      expect(dataTheme()).toBe('dark');
      expect(themeColors()).toEqual([DARK_CHROME, DARK_CHROME]);
    });

    it('resolves a system preference against the current OS setting', () => {
      prefersDark(true);

      store().initializeTheme();

      expect(store()).toMatchObject({ theme: 'system', resolvedTheme: 'dark', isDark: true });
    });

    it('registers the OS listener only once, however often it runs', () => {
      const matchMedia = createMatchMedia(false);
      vi.stubGlobal('matchMedia', matchMedia);

      store().initializeTheme();
      store().initializeTheme();

      const lists = matchMedia.mock.results.map((result) => result.value);
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) {
        expect(list.addEventListener).not.toHaveBeenCalled();
      }
    });
  });

  describe('OS theme changes', () => {
    it('are watched through a single listener on the color-scheme query', () => {
      expect(osThemeListeners).toHaveLength(1);
    });

    it('are followed while the preference is "system"', () => {
      switchOsTheme(true);

      expect(store()).toMatchObject({ theme: 'system', resolvedTheme: 'dark', isDark: true });
      expect(dataTheme()).toBe('dark');
      expect(themeColors()).toEqual([DARK_CHROME, DARK_CHROME]);

      switchOsTheme(false);

      expect(store()).toMatchObject({ resolvedTheme: 'light', isDark: false });
      expect(dataTheme()).toBeNull();
      expect(themeColors()).toEqual([LIGHT_CHROME, LIGHT_CHROME]);
    });

    it('are ignored once the user picked a theme explicitly', () => {
      store().setTheme('light');

      switchOsTheme(true);

      expect(store()).toMatchObject({ theme: 'light', resolvedTheme: 'light', isDark: false });
      expect(dataTheme()).toBeNull();
    });
  });

  describe('rehydration', () => {
    it('restores and applies the stored preference', async () => {
      localStorage.setItem(
        STORAGE_KEYS.THEME,
        JSON.stringify({ state: { theme: 'dark' }, version: 0 })
      );

      await useThemeStore.persist.rehydrate();

      expect(store()).toMatchObject({ theme: 'dark', resolvedTheme: 'dark', isDark: true });
      expect(dataTheme()).toBe('dark');
    });

    it('falls back to the system theme when nothing is stored', async () => {
      prefersDark(true);

      await useThemeStore.persist.rehydrate();

      expect(store()).toMatchObject({ theme: 'system', resolvedTheme: 'dark', isDark: true });
    });
  });

  describe('selector hooks', () => {
    it('useThemePreference and useIsDarkMode follow the store', () => {
      const preference = renderHook(() => useThemePreference());
      const isDark = renderHook(() => useIsDarkMode());
      expect(preference.result.current).toBe('system');
      expect(isDark.result.current).toBe(false);

      act(() => store().setTheme('dark'));

      expect(preference.result.current).toBe('dark');
      expect(isDark.result.current).toBe(true);
    });

    it('useTheme exposes the ThemeContext-compatible API', () => {
      const { result } = renderHook(() => useTheme());
      expect(result.current).toMatchObject({ theme: 'system', isDark: false });

      act(() => result.current.toggleTheme());
      expect(result.current).toMatchObject({ theme: 'dark', isDark: true });

      act(() => result.current.setTheme('light'));
      expect(result.current).toMatchObject({ theme: 'light', isDark: false });
    });
  });
});
