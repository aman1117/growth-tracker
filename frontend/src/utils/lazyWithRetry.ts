/**
 * lazyWithRetry
 *
 * `React.lazy` wrapper that survives deployments. After a new release, an open tab
 * (or an installed PWA) may request route chunks whose hashed filenames no longer
 * exist, which throws "Failed to fetch dynamically imported module" and crashes the
 * screen. We retry once and, if it still fails, reload the page a single time to pick
 * up the new build. A session flag prevents reload loops when genuinely offline.
 */

import { type ComponentType, lazy, type LazyExoticComponent } from 'react';

const RELOAD_FLAG_KEY = 'gt-chunk-reload-at';
const RELOAD_COOLDOWN_MS = 30_000;
const RETRY_DELAY_MS = 500;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const recentlyReloaded = (): boolean => {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_FLAG_KEY));
    return Number.isFinite(at) && Date.now() - at < RELOAD_COOLDOWN_MS;
  } catch {
    return false;
  }
};

const markReloaded = () => {
  try {
    sessionStorage.setItem(RELOAD_FLAG_KEY, String(Date.now()));
  } catch {
    // Ignore storage failures; worst case we skip the reload safeguard.
  }
};

export function lazyWithRetry<T extends ComponentType<object>>(
  factory: () => Promise<{ default: T }>,
  chunkName: string
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await factory();
    } catch (firstError) {
      console.warn('[lazyWithRetry] Chunk load failed, retrying', { chunkName });
      await wait(RETRY_DELAY_MS);
      try {
        return await factory();
      } catch (secondError) {
        if (navigator.onLine && !recentlyReloaded()) {
          console.warn('[lazyWithRetry] Reloading to fetch the latest build', { chunkName });
          markReloaded();
          window.location.reload();
          // Keep Suspense pending until the reload happens
          return new Promise<{ default: T }>(() => {});
        }
        console.error('[lazyWithRetry] Chunk load failed permanently', {
          chunkName,
          error: secondError instanceof Error ? secondError.message : String(firstError),
        });
        throw secondError;
      }
    }
  });
}
