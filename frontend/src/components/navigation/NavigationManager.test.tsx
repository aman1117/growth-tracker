import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { gl } from '../../services/goodlogs';
import { createNavigator, renderWithHistory } from '../../test/fixtures/shell';
import { signIn } from '../../test/utils';
import { EXTERNAL_NAVIGATE_EVENT } from '../../utils/navigation';
import { NavigationManager } from './NavigationManager';

const SCROLL_KEY = 'gt-scroll-positions';

type Entries = Parameters<typeof renderWithHistory>[1]['entries'];

const renderManager = (entries: Entries, index?: number) => {
  const navigator = createNavigator();
  const view = renderWithHistory(
    <>
      {navigator.element}
      <NavigationManager />
    </>,
    { entries, index }
  );
  return { ...view, go: navigator.go };
};

const location = () => screen.getByTestId('location');

/** Pretends the user scrolled the window to `y`. */
const scrollWindowTo = (y: number) => {
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(y);
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
};

const storedPositions = () => JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? 'null');

const externalNavigate = (detail: unknown) => {
  const event = new CustomEvent(EXTERNAL_NAVIGATE_EVENT, { detail, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
};

describe('NavigationManager', () => {
  let scrollTo: MockInstance<typeof window.scrollTo>;

  beforeEach(() => {
    scrollTo = vi.mocked(window.scrollTo);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('renders nothing', () => {
    const { container } = renderManager(['/']);

    expect(container.querySelector(':not([data-testid="location"])')).toBeNull();
  });

  describe('scroll position', () => {
    it('leaves the browser position alone on the first screen', () => {
      renderManager(['/']);

      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('opens new screens at the top', () => {
      const { go } = renderManager(['/']);

      go('/settings');

      expect(scrollTo).toHaveBeenCalledWith(0, 0);
    });

    it('keeps the position for in-place URL updates', () => {
      const { go } = renderManager(['/analytics']);

      go('/analytics?week=2024-05-06', { replace: true });

      expect(location()).toHaveTextContent('/analytics?week=2024-05-06');
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('scrolls to the top when a redirect replaces the screen', () => {
      const { go } = renderManager(['/login']);

      go('/', { replace: true });

      expect(scrollTo).toHaveBeenCalledWith(0, 0);
    });

    it('restores where the user was when going Back and Forward', () => {
      const { go } = renderManager(['/']);
      scrollWindowTo(640);

      go('/user/bob');
      scrollWindowTo(120);

      go(-1);
      expect(scrollTo).toHaveBeenLastCalledWith(0, 640);

      go(1);
      expect(scrollTo).toHaveBeenLastCalledWith(0, 120);
    });

    it('starts at the top when going Back to a screen without a saved position', () => {
      const { go } = renderManager(['/about', '/settings']);

      go(-1);

      expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    });

    it('does not let late scroll events overwrite the position of the screen just left', () => {
      const { go } = renderManager(['/']);
      scrollWindowTo(500);

      go('/settings');
      scrollWindowTo(0); // the new screen resets to the top
      go(-1);

      expect(scrollTo).toHaveBeenLastCalledWith(0, 500);
    });

    describe('while the previous page is still loading', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      /** Saves 800px for "/" and goes Back to it while the page is still short. */
      const goBackToTallPage = () => {
        const { go } = renderManager(['/']);
        scrollWindowTo(800);
        go('/settings');
        scrollWindowTo(0);
        scrollTo.mockClear();
        go(-1);
        return go;
      };

      it('keeps retrying until the page is tall enough', () => {
        goBackToTallPage();
        expect(scrollTo).toHaveBeenCalledWith(0, 800);

        act(() => vi.advanceTimersByTime(100));
        const attempts = scrollTo.mock.calls.length;
        expect(attempts).toBeGreaterThan(1);

        vi.spyOn(window, 'scrollY', 'get').mockReturnValue(799);
        act(() => vi.advanceTimersByTime(100));
        const final = scrollTo.mock.calls.length;

        act(() => vi.advanceTimersByTime(500));
        expect(scrollTo).toHaveBeenCalledTimes(final);
      });

      it('gives up after a short while', () => {
        goBackToTallPage();

        act(() => vi.advanceTimersByTime(1300));
        const attempts = scrollTo.mock.calls.length;

        act(() => vi.advanceTimersByTime(1000));
        expect(scrollTo).toHaveBeenCalledTimes(attempts);
      });

      it.each(['wheel', 'touchstart', 'keydown'])(
        'stops as soon as the user takes over (%s)',
        (type) => {
          goBackToTallPage();

          act(() => {
            window.dispatchEvent(new Event(type));
          });
          const attempts = scrollTo.mock.calls.length;

          act(() => vi.advanceTimersByTime(500));
          expect(scrollTo).toHaveBeenCalledTimes(attempts);
        }
      );

      it('stops when the user navigates again', () => {
        const go = goBackToTallPage();

        go('/analytics');
        const attempts = scrollTo.mock.calls.length;

        act(() => vi.advanceTimersByTime(500));
        expect(scrollTo).toHaveBeenCalledTimes(attempts);
      });
    });
  });

  describe('scroll positions across reloads', () => {
    it('saves positions when the page is hidden', () => {
      renderManager([{ pathname: '/', key: 'home' }]);
      scrollWindowTo(300);

      window.dispatchEvent(new Event('pagehide'));

      expect(storedPositions()).toEqual({ home: 300 });
    });

    it('restores positions saved before a reload', () => {
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ home: 420 }));
      const { go } = renderManager([
        { pathname: '/', key: 'home' },
        { pathname: '/settings', key: 'settings' },
      ]);

      go(-1);

      expect(scrollTo).toHaveBeenLastCalledWith(0, 420);
    });

    it('keeps only the 50 most recent positions', () => {
      const saved = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`entry-${i}`, i]));
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify(saved));
      renderManager([{ pathname: '/', key: 'entry-59' }]);

      window.dispatchEvent(new Event('pagehide'));

      const stored = storedPositions();
      expect(Object.keys(stored)).toHaveLength(50);
      expect(stored).not.toHaveProperty('entry-9');
      expect(stored).toMatchObject({ 'entry-10': 10, 'entry-59': 59 });
    });

    it.each([
      ['malformed JSON', '{not json'],
      ['a non-object value', '42'],
    ])('ignores %s in storage', (_label, raw) => {
      sessionStorage.setItem(SCROLL_KEY, raw);
      const { go } = renderManager([
        { pathname: '/', key: 'home' },
        { pathname: '/settings', key: 'settings' },
      ]);

      go(-1);

      expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    });

    it('carries on when storage is full or disabled', () => {
      renderManager(['/']);
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      try {
        expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
        expect(setItem).toHaveBeenCalledWith(SCROLL_KEY, expect.any(String));
      } finally {
        // Persisted stores write to storage while they are reset after the test
        setItem.mockRestore();
      }
    });

    it('stops tracking after unmounting', () => {
      const { unmount } = renderManager([{ pathname: '/', key: 'home' }]);
      unmount();

      scrollWindowTo(300);
      window.dispatchEvent(new Event('pagehide'));

      expect(sessionStorage.getItem(SCROLL_KEY)).toBeNull();
    });
  });

  describe('browser scroll restoration', () => {
    it('takes over from the browser and hands back control on unmount', () => {
      // jsdom does not implement history.scrollRestoration; emulate a browser that does
      window.history.scrollRestoration = 'auto';
      try {
        const { unmount } = renderManager(['/']);
        expect(window.history.scrollRestoration).toBe('manual');

        unmount();
        expect(window.history.scrollRestoration).toBe('auto');
      } finally {
        Reflect.deleteProperty(window.history, 'scrollRestoration');
      }
    });
  });

  describe('document title', () => {
    beforeEach(() => {
      signIn({ username: 'alice' });
    });

    it.each([
      ['/', 'Growth Tracker'],
      ['/login', 'Log in · Growth Tracker'],
      ['/forgot-password', 'Forgot password · Growth Tracker'],
      ['/settings', 'Settings · Growth Tracker'],
      ['/analytics', 'Insights · Growth Tracker'],
      ['/analytics?user=bob', '@bob · Insights · Growth Tracker'],
      ['/user/bob', '@bob · Growth Tracker'],
      ['/user/alice', 'Growth Tracker'],
    ])('names %s "%s"', (route, title) => {
      renderManager([route]);

      expect(document.title).toBe(title);
    });

    it('follows navigation and sign-in changes', () => {
      const { go } = renderManager(['/settings']);
      expect(document.title).toBe('Settings · Growth Tracker');

      go('/user/carol');
      expect(document.title).toBe('@carol · Growth Tracker');

      act(() => {
        signIn({ username: 'carol' });
      });
      expect(document.title).toBe('Growth Tracker');
    });
  });

  describe('navigation requests from outside React', () => {
    it('opens same-origin links in the app and marks the request handled', () => {
      renderManager(['/']);

      const event = externalNavigate({
        url: `${window.location.origin}/user/bob?date=2024-05-01#comments`,
      });

      expect(event.defaultPrevented).toBe(true);
      expect(location()).toHaveTextContent('/user/bob?date=2024-05-01');
    });

    it('accepts paths relative to the app', () => {
      renderManager(['/']);

      externalNavigate({ url: '/settings' });

      expect(location()).toHaveTextContent('/settings');
    });

    it('does not navigate again to the page that is already open', () => {
      window.history.replaceState(null, '', '/settings');
      renderManager(['/settings']);
      const navigations = vi.mocked(gl.debug).mock.calls.length;

      const event = externalNavigate({ url: '/settings' });

      expect(event.defaultPrevented).toBe(true);
      expect(gl.debug).toHaveBeenCalledTimes(navigations);
    });

    it.each([
      ['no detail', null],
      ['no URL', {}],
      ['another origin', { url: 'https://evil.example/user/bob' }],
    ])('ignores requests with %s', (_label, detail) => {
      renderManager(['/']);

      const event = externalNavigate(detail);

      expect(event.defaultPrevented).toBe(false);
      expect(location()).toHaveTextContent(/^\/$/);
    });

    it('warns about malformed URLs', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderManager(['/']);

      const event = externalNavigate({ url: 'http://[not-a-host' });

      expect(event.defaultPrevented).toBe(false);
      expect(warn).toHaveBeenCalledWith('[Navigation]', 'Ignoring malformed navigation URL');
    });

    it('stops listening after unmounting', () => {
      const { unmount } = renderManager(['/']);
      unmount();

      expect(externalNavigate({ url: '/settings' }).defaultPrevented).toBe(false);
    });
  });

  describe('navigation logging', () => {
    it('logs every navigation with the route pattern instead of usernames', () => {
      const { go } = renderManager(['/']);
      expect(gl.debug).toHaveBeenLastCalledWith('navigation', {
        metadata: { action: 'POP', route: '/' },
      });

      go('/user/bob');
      expect(gl.debug).toHaveBeenLastCalledWith('navigation', {
        metadata: { action: 'PUSH', route: '/user/:username' },
      });

      go('/analytics/bob', { replace: true });
      expect(gl.debug).toHaveBeenLastCalledWith('navigation', {
        metadata: { action: 'REPLACE', route: '/analytics/:username' },
      });
      expect(console.debug).toHaveBeenCalledWith('[Navigation]', 'REPLACE', '/analytics/:username');
    });
  });
});
