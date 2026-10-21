/**
 * Shared fixtures for the "core" test scope: services, utils, hooks, config and constants.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createElement, type ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { vi } from 'vitest';

import type { Notification } from '../../types';

/** Builds a notification like the API/WebSocket delivers it. */
export function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    type: 'like_received',
    title: 'New like',
    body: 'alice liked your day',
    metadata: null,
    read_at: null,
    created_at: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

/** Builds a `File` with an explicit size (jsdom derives `size` from the content otherwise). */
export function makeFile(name = 'photo.png', type = 'image/png', size = 1024): File {
  const file = new File(['image-bytes'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function NavigationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return createElement(
    'output',
    { 'data-testid': 'navigation' },
    `${navigationType} ${location.pathname}${location.search}`
  );
}

/**
 * `renderHook` wrapper that mounts the hook inside a MemoryRouter. A
 * `[data-testid="navigation"]` element shows the last navigation as
 * `PUSH|REPLACE|POP <pathname><search>`.
 */
export function routerWrapper(initialEntries: string[] = ['/'], initialIndex?: number) {
  return function RouterWrapper({ children }: { children: ReactNode }) {
    return createElement(
      MemoryRouter,
      { initialEntries, initialIndex },
      children,
      createElement(NavigationProbe)
    );
  };
}

/**
 * Records `popstate` listeners that modules add to `window` during a test and returns a
 * function that removes them. Module singletons (e.g. overlay history) re-imported after
 * `vi.resetModules()` would otherwise keep reacting to later tests' history changes.
 */
export function trackPopstateListeners(): () => void {
  const addSpy = vi.spyOn(window, 'addEventListener');
  return () => {
    for (const [type, listener] of addSpy.mock.calls) {
      if (type === 'popstate') window.removeEventListener(type, listener);
    }
  };
}

/** Resolves after the next `popstate` event (jsdom fires it asynchronously after `history.back()`). */
export function nextPopState(): Promise<PopStateEvent> {
  return new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
}

/**
 * Reads a file under `src/` as text. Use it for stylesheets: Vitest replaces every CSS
 * import (even `?raw`) with an empty string.
 */
export function readSrcFile(pathFromSrc: string): string {
  return readFileSync(resolve(import.meta.dirname, '../..', pathFromSrc), 'utf8');
}
