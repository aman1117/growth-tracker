/**
 * Navigation Utilities
 *
 * Pure helpers shared by the router shell, bottom navigation and page headers.
 * Keeping these side-effect free makes route behaviour predictable and testable.
 */

import { APP_ROUTES } from '../constants/routes';

export const APP_NAME = 'Growth Tracker';

/** Primary destinations reachable from the bottom tab bar */
export type AppTab = 'home' | 'analytics' | 'profile';

/** Window event fired when the user taps the tab they are already on */
export const TAB_RESELECT_EVENT = 'app:tab-reselect';

/** Window event used to request an in-app (SPA) navigation from outside the router */
export const EXTERNAL_NAVIGATE_EVENT = 'app:navigate';

export interface TabReselectDetail {
  tab: AppTab;
}

export interface ExternalNavigateDetail {
  url: string;
}

/** Location state passed to the login page so we can return the user afterwards */
export interface RedirectState {
  from?: string;
}

/** Location state understood by the Home (dashboard) screen */
export interface HomeNavigationState {
  /** Open tile customisation once the dashboard is ready */
  enterEditMode?: boolean;
}

const AUTH_FLOW_ROUTES: readonly string[] = [
  APP_ROUTES.FORGOT_PASSWORD,
  APP_ROUTES.RESET_PASSWORD,
  APP_ROUTES.VERIFY_EMAIL,
];

const PROFILE_PATH_PREFIX = '/user/';
const ANALYTICS_PATH_PREFIX = `${APP_ROUTES.ANALYTICS}/`;

export const isAuthFlowRoute = (pathname: string): boolean => AUTH_FLOW_ROUTES.includes(pathname);

export const isLoginRoute = (pathname: string): boolean => pathname === APP_ROUTES.LOGIN;

/** Extracts the username from `/user/:username`, or null for other paths */
export const getProfileUsername = (pathname: string): string | null => {
  if (!pathname.startsWith(PROFILE_PATH_PREFIX)) return null;
  const raw = pathname.slice(PROFILE_PATH_PREFIX.length).split('/')[0];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** Extracts the analytics target from `/analytics?user=x` or `/analytics/:username` */
export const getAnalyticsUsername = (pathname: string, search: string): string | null => {
  if (pathname !== APP_ROUTES.ANALYTICS && !pathname.startsWith(ANALYTICS_PATH_PREFIX)) {
    return null;
  }
  const fromQuery = new URLSearchParams(search).get('user');
  if (fromQuery) return fromQuery;
  const fromPath = pathname.slice(ANALYTICS_PATH_PREFIX.length).split('/')[0];
  return fromPath || null;
};

const isSameUser = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Determines which bottom tab (if any) represents the current screen.
 * Screens that belong to *another* user are "pushed" screens and highlight no tab,
 * matching the behaviour of Instagram / Threads style tab bars.
 */
export const getActiveTab = (
  pathname: string,
  search: string,
  ownUsername: string | undefined
): AppTab | null => {
  if (pathname === APP_ROUTES.HOME) return 'home';

  const profileUsername = getProfileUsername(pathname);
  if (profileUsername) return isSameUser(profileUsername, ownUsername) ? 'home' : null;

  if (pathname === APP_ROUTES.ANALYTICS || pathname.startsWith(ANALYTICS_PATH_PREFIX)) {
    const target = getAnalyticsUsername(pathname, search);
    return !target || isSameUser(target, ownUsername) ? 'analytics' : null;
  }

  if (pathname === APP_ROUTES.SETTINGS) return 'profile';

  return null;
};

/** Root route for each tab — what tapping the tab navigates to */
export const TAB_ROUTES: Record<AppTab, string> = {
  home: APP_ROUTES.HOME,
  analytics: APP_ROUTES.ANALYTICS,
  profile: APP_ROUTES.SETTINGS,
};

/** Human-readable document title for a location */
export const getRouteTitle = (
  pathname: string,
  search: string,
  ownUsername: string | undefined
): string => {
  const withApp = (title: string) => `${title} · ${APP_NAME}`;

  if (pathname === APP_ROUTES.LOGIN) return withApp('Log in');
  if (pathname === APP_ROUTES.FORGOT_PASSWORD) return withApp('Forgot password');
  if (pathname === APP_ROUTES.RESET_PASSWORD) return withApp('Reset password');
  if (pathname === APP_ROUTES.VERIFY_EMAIL) return withApp('Verify email');
  if (pathname === APP_ROUTES.SETTINGS) return withApp('Settings');

  const analyticsUser = getAnalyticsUsername(pathname, search);
  if (pathname === APP_ROUTES.ANALYTICS || analyticsUser) {
    return analyticsUser && !isSameUser(analyticsUser, ownUsername)
      ? withApp(`@${analyticsUser} · Analytics`)
      : withApp('Analytics');
  }

  const profileUsername = getProfileUsername(pathname);
  if (profileUsername && !isSameUser(profileUsername, ownUsername)) {
    return withApp(`@${profileUsername}`);
  }

  return APP_NAME;
};

/**
 * True when the browser history contains an earlier entry created by this SPA.
 * React Router stores a monotonically increasing `idx` in `history.state`.
 */
export const hasInAppHistory = (): boolean => {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
};

/**
 * Validates a post-login redirect target to prevent open redirects and loops.
 * Only same-origin, absolute in-app paths are allowed.
 */
export const getSafeRedirectPath = (from: unknown): string => {
  if (typeof from !== 'string') return APP_ROUTES.HOME;
  if (!from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) {
    return APP_ROUTES.HOME;
  }
  const pathname = from.split(/[?#]/)[0];
  if (isLoginRoute(pathname) || isAuthFlowRoute(pathname)) return APP_ROUTES.HOME;
  return from;
};

/**
 * Normalises a pathname to its route pattern for logging, so user handles are not
 * written to analytics (e.g. `/user/jane` → `/user/:username`).
 */
export const toRoutePattern = (pathname: string): string => {
  if (getProfileUsername(pathname)) return '/user/:username';
  if (pathname.startsWith(ANALYTICS_PATH_PREFIX)) return '/analytics/:username';
  return pathname;
};

/** Smoothly scrolls to the top, respecting the user's reduced-motion preference */
export const scrollToTop = (): void => {
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
};
