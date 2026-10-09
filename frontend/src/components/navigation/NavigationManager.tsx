/**
 * NavigationManager
 *
 * Headless component mounted once inside the Router. It owns app-wide navigation
 * behaviour that individual pages should not have to re-implement:
 * - scroll position: new screens open at the top, Back/Forward restores where you were;
 * - document title per screen (tab title, history menu, screen readers);
 * - in-app navigation requests coming from outside React (service worker clicks);
 * - structured navigation logs.
 */

import type { FC } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

import { gl } from '../../services/goodlogs';
import { syncOverlayHistoryIndex } from '../../services/overlayHistory';
import { useAuth } from '../../store';
import {
  EXTERNAL_NAVIGATE_EVENT,
  type ExternalNavigateDetail,
  getRouteTitle,
  toRoutePattern,
} from '../../utils/navigation';

const LOG_TAG = '[Navigation]';
const SCROLL_STORAGE_KEY = 'gt-scroll-positions';
const MAX_STORED_POSITIONS = 50;
const RESTORE_TIMEOUT_MS = 1200;

type ScrollPositions = Record<string, number>;

const loadPositions = (): ScrollPositions => {
  try {
    const raw = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as ScrollPositions) : {};
  } catch {
    return {};
  }
};

const persistPositions = (positions: ScrollPositions) => {
  try {
    const entries = Object.entries(positions).slice(-MAX_STORED_POSITIONS);
    sessionStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage may be full or disabled (private mode) — restoration is best-effort.
  }
};

/**
 * Restores a scroll offset once the page is tall enough to reach it. Pages fetch
 * data after mounting, so we retry for a short window and stop early if the user
 * starts scrolling themselves.
 */
const restoreScroll = (target: number): (() => void) => {
  const startedAt = performance.now();
  let frame = 0;
  let cancelled = false;

  const cancel = () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('wheel', cancel);
    window.removeEventListener('touchstart', cancel);
    window.removeEventListener('keydown', cancel);
  };

  const attempt = () => {
    if (cancelled) return;
    window.scrollTo(0, target);
    const reached = Math.abs(window.scrollY - target) <= 2;
    if (reached || performance.now() - startedAt > RESTORE_TIMEOUT_MS) {
      cancel();
      return;
    }
    frame = requestAnimationFrame(attempt);
  };

  window.addEventListener('wheel', cancel, { passive: true });
  window.addEventListener('touchstart', cancel, { passive: true });
  window.addEventListener('keydown', cancel);
  attempt();
  return cancel;
};

const useScrollRestoration = () => {
  const location = useLocation();
  const navigationType = useNavigationType();
  const positionsRef = useRef<ScrollPositions>(loadPositions());
  const previousPathRef = useRef<string | null>(null);
  // History entry that scroll events are attributed to. Switched synchronously in the
  // layout effect so late scroll events (e.g. from the new page resetting to the top)
  // never overwrite the position saved for the screen we just left.
  const activeKeyRef = useRef(location.key);

  // We manage scrolling ourselves; the browser's default fights with SPA rendering.
  useEffect(() => {
    const canControlRestoration = 'scrollRestoration' in window.history;
    const previous = canControlRestoration ? window.history.scrollRestoration : undefined;
    if (canControlRestoration) window.history.scrollRestoration = 'manual';

    const handleScroll = () => {
      positionsRef.current[activeKeyRef.current] = window.scrollY;
    };
    const handlePageHide = () => persistPositions(positionsRef.current);

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('pagehide', handlePageHide);
      if (canControlRestoration && previous) window.history.scrollRestoration = previous;
    };
  }, []);

  // Decide where the new screen should start
  useLayoutEffect(() => {
    activeKeyRef.current = location.key;
    const previousPath = previousPathRef.current;
    previousPathRef.current = location.pathname;
    if (previousPath === null) return; // initial load: leave the browser position alone

    if (navigationType === 'POP') {
      return restoreScroll(positionsRef.current[location.key] ?? 0);
    }

    // In-place URL updates (filters, deep-link params) should not jump the page
    if (navigationType === 'REPLACE' && previousPath === location.pathname) return;

    window.scrollTo(0, 0);
  }, [location.key, location.pathname, navigationType]);
};

const useDocumentTitle = () => {
  const { pathname, search } = useLocation();
  const { user } = useAuth();

  useEffect(() => {
    document.title = getRouteTitle(pathname, search, user?.username);
  }, [pathname, search, user?.username]);
};

/**
 * Lets non-React code (e.g. the service-worker message handler in main.tsx) request
 * an SPA navigation. Handlers call `preventDefault()` to signal the event was handled,
 * so the dispatcher can fall back to a full page load if the app is not mounted.
 */
const useExternalNavigationBridge = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const handleExternalNavigate = (event: Event) => {
      const detail = (event as CustomEvent<ExternalNavigateDetail>).detail;
      if (!detail?.url) return;

      let target: URL;
      try {
        target = new URL(detail.url, window.location.origin);
      } catch {
        console.warn(LOG_TAG, 'Ignoring malformed navigation URL');
        return;
      }
      if (target.origin !== window.location.origin) return;

      event.preventDefault();
      const path = `${target.pathname}${target.search}${target.hash}`;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (path !== current) {
        navigate(path);
      }
    };

    window.addEventListener(EXTERNAL_NAVIGATE_EVENT, handleExternalNavigate);
    return () => window.removeEventListener(EXTERNAL_NAVIGATE_EVENT, handleExternalNavigate);
  }, [navigate]);
};

const useNavigationLogging = () => {
  const { pathname, key } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    syncOverlayHistoryIndex();
    const route = toRoutePattern(pathname);
    if (import.meta.env.DEV) {
      console.debug(LOG_TAG, navigationType, route);
    }
    gl.debug('navigation', { metadata: { action: navigationType, route } });
  }, [key, pathname, navigationType]);
};

export const NavigationManager: FC = () => {
  useScrollRestoration();
  useDocumentTitle();
  useExternalNavigationBridge();
  useNavigationLogging();
  return null;
};

export default NavigationManager;
