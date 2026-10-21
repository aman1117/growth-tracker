/**
 * Global test setup (runs before every test file).
 */
import '@testing-library/jest-dom/vitest';

import { act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { createMatchMedia, MockIntersectionObserver, MockResizeObserver } from './browser-mocks';
import { resetAllStores, withResettableStores } from './zustand';

vi.mock('zustand', async (importOriginal) =>
  withResettableStores(await importOriginal<typeof import('zustand')>())
);
vi.mock('@aj-2000-test/goodlogs-sdk', async () => await import('./stubs/goodlogs-sdk'));

// Some modules (e.g. the theme store) call matchMedia while being imported, before any
// beforeEach runs, so install a baseline once. Tests re-stub it below and get this back after.
window.matchMedia = createMatchMedia();

beforeEach(() => {
  // jsdom gaps. Globals are restored after each test (unstubGlobals), so re-stub here.
  vi.stubGlobal('matchMedia', createMatchMedia());
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('scrollTo', vi.fn());
  // Unit tests never reach the network: an unmocked request fails the calling code loudly.
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) =>
      Promise.reject(new Error(`Unmocked fetch: ${String(input)}`))
    )
  );
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as typeof Element.prototype.scrollTo;
  URL.createObjectURL = vi.fn(() => 'blob:mock-object-url');
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  // Unmount on real timers: overlays closing on unmount go Back in history, and a traversal
  // queued on fake timers would be dropped, leaving overlay history waiting for it forever
  vi.useRealTimers();
  cleanup();
  // Let those traversals finish, then start the next test from a fresh page's overlay state.
  // importActual: some test files mock this module, and a mock has no reset to call.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const overlayHistory = await vi.importActual<typeof import('../services/overlayHistory')>(
    '../services/overlayHistory'
  );
  overlayHistory.resetOverlayHistory();
  act(() => resetAllStores());
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.className = '';
});
