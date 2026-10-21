import { describe, expect, it, vi } from 'vitest';

import { createMatchMedia } from '../test/utils';
import {
  APP_NAME,
  EXTERNAL_NAVIGATE_EVENT,
  getActiveTab,
  getAnalyticsUsername,
  getProfileUsername,
  getRouteTitle,
  getSafeRedirectPath,
  hasInAppHistory,
  isAuthFlowRoute,
  isLoginRoute,
  scrollToTop,
  TAB_RESELECT_EVENT,
  TAB_ROUTES,
  toRoutePattern,
} from './navigation';

describe('route predicates', () => {
  it.each([
    ['/forgot-password', true],
    ['/reset-password', true],
    ['/verify-email', true],
    ['/login', false],
    ['/settings', false],
  ])('isAuthFlowRoute(%s) is %s', (pathname, expected) => {
    expect(isAuthFlowRoute(pathname)).toBe(expected);
  });

  it('recognises only the login route as the login page', () => {
    expect(isLoginRoute('/login')).toBe(true);
    expect(isLoginRoute('/login/help')).toBe(false);
    expect(isLoginRoute('/')).toBe(false);
  });
});

describe('getProfileUsername', () => {
  it.each([
    ['/user/alice', 'alice'],
    ['/user/alice/followers', 'alice'],
    ['/user/zo%C3%AB', 'zoë'],
    // Malformed escapes are returned as-is instead of throwing.
    ['/user/%E0%A4%A', '%E0%A4%A'],
    ['/user/', null],
    ['/users/alice', null],
    ['/', null],
  ])('%s → %s', (pathname, username) => {
    expect(getProfileUsername(pathname)).toBe(username);
  });
});

describe('getAnalyticsUsername', () => {
  it.each([
    ['/analytics', '?user=bob', 'bob'],
    ['/analytics/carol', '', 'carol'],
    ['/analytics/carol', '?user=dave', 'dave'],
    ['/analytics', '', null],
    ['/analytics/', '', null],
    ['/settings', '?user=bob', null],
  ])('%s%s → %s', (pathname, search, username) => {
    expect(getAnalyticsUsername(pathname, search)).toBe(username);
  });
});

describe('getActiveTab', () => {
  it.each([
    ['/', '', 'alice', 'home'],
    ['/user/alice', '', 'alice', 'home'],
    ['/user/ALICE', '', 'alice', 'home'],
    ['/user/bob', '', 'alice', null],
    ['/user/bob', '', undefined, null],
    ['/analytics', '', 'alice', 'analytics'],
    ['/analytics', '?user=alice', 'alice', 'analytics'],
    ['/analytics/Alice', '', 'alice', 'analytics'],
    ['/analytics', '?user=bob', 'alice', null],
    ['/analytics/bob', '', 'alice', null],
    ['/settings', '', 'alice', 'profile'],
    ['/login', '', undefined, null],
    ['/user/', '', 'alice', null],
  ])('%s%s for %s → %s', (pathname, search, own, tab) => {
    expect(getActiveTab(pathname, search, own)).toBe(tab);
  });

  it('maps every tab to its root route', () => {
    expect(TAB_ROUTES).toEqual({ home: '/', analytics: '/analytics', profile: '/settings' });
    (Object.keys(TAB_ROUTES) as Array<keyof typeof TAB_ROUTES>).forEach((tab) => {
      expect(getActiveTab(TAB_ROUTES[tab], '', 'alice')).toBe(tab);
    });
  });
});

describe('getRouteTitle', () => {
  it.each([
    ['/login', '', undefined, 'Log in · Growth Tracker'],
    ['/forgot-password', '', undefined, 'Forgot password · Growth Tracker'],
    ['/reset-password', '', undefined, 'Reset password · Growth Tracker'],
    ['/verify-email', '', undefined, 'Verify email · Growth Tracker'],
    ['/settings', '', 'alice', 'Settings · Growth Tracker'],
    ['/analytics', '', 'alice', 'Insights · Growth Tracker'],
    ['/analytics', '?user=Alice', 'alice', 'Insights · Growth Tracker'],
    ['/analytics', '?user=bob', 'alice', '@bob · Insights · Growth Tracker'],
    ['/analytics/bob', '', undefined, '@bob · Insights · Growth Tracker'],
    ['/user/bob', '', 'alice', '@bob · Growth Tracker'],
    ['/user/alice', '', 'alice', 'Growth Tracker'],
    ['/', '', 'alice', 'Growth Tracker'],
    ['/somewhere-else', '', 'alice', 'Growth Tracker'],
  ])('%s%s for %s → "%s"', (pathname, search, own, title) => {
    expect(getRouteTitle(pathname, search, own)).toBe(title);
  });

  it('uses the app name as the default title', () => {
    expect(APP_NAME).toBe('Growth Tracker');
  });
});

describe('hasInAppHistory', () => {
  it.each([
    [null, false],
    [{}, false],
    [{ idx: 0 }, false],
    [{ idx: '3' }, false],
    [{ idx: 3 }, true],
  ])('history.state %o → %s', (state, expected) => {
    window.history.replaceState(state, '');
    expect(hasInAppHistory()).toBe(expected);
  });
});

describe('getSafeRedirectPath', () => {
  it.each([
    [undefined, '/'],
    [42, '/'],
    ['dashboard', '/'],
    ['https://evil.example.com', '/'],
    ['//evil.example.com', '/'],
    ['/\\evil.example.com', '/'],
    ['/login', '/'],
    ['/login?next=/settings', '/'],
    ['/forgot-password#top', '/'],
    ['/verify-email', '/'],
    ['/settings', '/settings'],
    ['/user/alice?date=2026-10-20#comments', '/user/alice?date=2026-10-20#comments'],
  ])('%o → %s', (from, expected) => {
    expect(getSafeRedirectPath(from)).toBe(expected);
  });
});

describe('toRoutePattern', () => {
  it.each([
    ['/user/jane', '/user/:username'],
    ['/user/jane/followers', '/user/:username'],
    ['/analytics/jane', '/analytics/:username'],
    ['/analytics', '/analytics'],
    ['/settings', '/settings'],
    ['/user/', '/user/'],
  ])('%s → %s', (pathname, pattern) => {
    expect(toRoutePattern(pathname)).toBe(pattern);
  });
});

describe('scrollToTop', () => {
  it('scrolls smoothly by default', () => {
    scrollToTop();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('jumps instantly when the user prefers reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      createMatchMedia((query) => query.includes('reduce'))
    );

    scrollToTop();

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('still scrolls when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);

    scrollToTop();

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });
});

it('namespaces the app-level window events', () => {
  expect(TAB_RESELECT_EVENT).toBe('app:tab-reselect');
  expect(EXTERNAL_NAVIGATE_EVENT).toBe('app:navigate');
});
