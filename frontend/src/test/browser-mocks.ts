/**
 * Stand-ins for browser APIs that jsdom does not implement.
 */
import { vi } from 'vitest';

export class MockIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
  readonly scrollMargin = '0px';
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}

export class MockResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

/**
 * Returns a `matchMedia` mock. `matches` may be a boolean for every query or a predicate,
 * e.g. `createMatchMedia((q) => q.includes('prefers-color-scheme: dark'))`.
 */
export function createMatchMedia(matches: boolean | ((query: string) => boolean) = false) {
  return vi.fn((query: string) => ({
    matches: typeof matches === 'function' ? matches(query) : matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }));
}
