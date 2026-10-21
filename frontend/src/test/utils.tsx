/**
 * Shared helpers for component and hook tests.
 */
import { render, type RenderOptions } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';

import { STORAGE_KEYS } from '../constants/storage';
import { useAuthStore, type User } from '../store/useAuthStore';

export { createMatchMedia } from './browser-mocks';

interface RenderWithRouterOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial URL, e.g. `/user/alice?tab=followers`. */
  route?: string;
  /** Route pattern to mount `ui` at, so `useParams` works, e.g. `/user/:username`. */
  path?: string;
}

/**
 * Renders `ui` inside a MemoryRouter and returns Testing Library's queries plus a
 * `user-event` instance. A hidden `[data-testid="location"]` element always shows the
 * current pathname + search, so navigation can be asserted.
 */
export function renderWithRouter(
  ui: ReactElement,
  { route = '/', path, ...options }: RenderWithRouterOptions = {}
) {
  const user = userEvent.setup();
  const result = render(
    <MemoryRouter initialEntries={[route]}>
      {path ? (
        <Routes>
          <Route path={path} element={ui} />
          <Route path="*" element={null} />
        </Routes>
      ) : (
        ui
      )}
      <LocationProbe />
    </MemoryRouter>,
    options
  );
  return { user, ...result };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <span data-testid="location" hidden>
      {location.pathname + location.search}
    </span>
  );
}

/** Builds a JSON `Response` like the API returns. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

/**
 * Replaces `fetch` with a mock. Pass a handler to answer by URL/method, e.g.
 * `mockFetch((url, init) => url.endsWith('/api/login') ? jsonResponse({...}) : undefined)`.
 * Returning `undefined` makes the request fail, so unexpected calls are noticed.
 */
export function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await handler(url, init);
    if (!response) {
      throw new Error(`Unhandled fetch: ${init?.method ?? 'GET'} ${url}`);
    }
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Signs a user in the way the app does after login (store + localStorage token). */
export function signIn(user: Partial<User> = {}, token = 'test-access-token'): User {
  const full: User = { id: 1, username: 'testuser', ...user };
  localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, token);
  localStorage.setItem(STORAGE_KEYS.USERNAME, full.username);
  localStorage.setItem(STORAGE_KEYS.USER_ID, String(full.id));
  useAuthStore.setState({ user: full, isAuthenticated: true, isLoading: false });
  return full;
}
