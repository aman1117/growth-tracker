import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { STORAGE_KEYS } from './constants/storage';
import { api } from './services/api';
import { gl } from './services/goodlogs';
import { useAuthStore, usePushStore, useThemeStore } from './store';
import { nowInSeconds, signOut, tokenWith } from './test/fixtures/shell';
import { signIn } from './test/utils';

/** Lets a test make a lazily loaded screen fail to load, like a stale chunk after a deploy. */
const chunks = vi.hoisted(() => {
  const failures: Record<string, number> = {};
  return {
    failures,
    load(name: string) {
      if ((failures[name] ?? 0) > 0) {
        failures[name] -= 1;
        throw new Error(`Failed to fetch dynamically imported module: ${name}`);
      }
    },
  };
});

// Heavy screens are replaced with headings; they have their own suites.
vi.mock('./components/Dashboard', async () => {
  const { useParams } = await import('react-router-dom');
  return {
    Dashboard: () => {
      const { username } = useParams();
      return <h1>{username ? `Dashboard of ${username}` : 'Your dashboard'}</h1>;
    },
  };
});
vi.mock('./components/SettingsPage', () => ({ SettingsPage: () => <h1>Settings</h1> }));
vi.mock('./components/AnalyticsPage', () => {
  chunks.load('AnalyticsPage');
  return { AnalyticsPage: () => <h1>Insights</h1> };
});
vi.mock('./components/challenges/ChallengesPage', () => ({
  ChallengesPage: () => <h1>Your challenges</h1>,
}));
vi.mock('./components/challenges/ChallengeDetailPage', async () => {
  const { useParams } = await import('react-router-dom');
  return {
    ChallengeDetailPage: () => {
      const { id } = useParams();
      return <h1>{`Challenge ${id}`}</h1>;
    },
  };
});
vi.mock('./components/challenges/JoinChallengePage', async () => {
  const { useParams } = await import('react-router-dom');
  return {
    JoinChallengePage: () => {
      const { code } = useParams();
      return <h1>{`Invite ${code}`}</h1>;
    },
  };
});
vi.mock('./components/VerifyEmail', async (importOriginal) => {
  chunks.load('VerifyEmail');
  return importOriginal();
});
vi.mock('./components/ResetPassword', async (importOriginal) => {
  chunks.load('ResetPassword');
  return importOriginal();
});
// The notification center would otherwise open a real WebSocket
vi.mock('./hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }));
vi.mock('./services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/api')>()),
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

const renderAppAt = (url: string) => {
  window.history.pushState({}, '', url);
  const user = userEvent.setup();
  return { user, ...render(<App />) };
};

const currentUrl = () => `${window.location.pathname}${window.location.search}`;
const findHeading = (name: string, timeout?: number) =>
  screen.findByRole('heading', { name }, timeout ? { timeout } : undefined);

describe('App', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({});
    signOut();
    // NavigationManager logs every navigation in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  describe('route guards', () => {
    it('sends signed-out visitors to the login screen', async () => {
      renderAppAt('/');

      expect(await findHeading('Welcome back')).toBeInTheDocument();
      expect(currentUrl()).toBe('/login');
      // The title is set in an effect, which may run just after the screen appears
      await waitFor(() => expect(document.title).toBe('Log in · Growth Tracker'));
    });

    it('brings visitors back to their deep link after logging in', async () => {
      post.mockResolvedValue({
        success: true,
        access_token: tokenWith({ user_id: 7, username: 'alice' }),
      });
      const { user } = renderAppAt('/settings?tab=privacy');

      await findHeading('Welcome back');
      await user.type(screen.getByLabelText('Username or email'), 'alice');
      await user.type(screen.getByLabelText('Password'), 'password123{Enter}');

      expect(await findHeading('Settings')).toBeInTheDocument();
      expect(currentUrl()).toBe('/settings?tab=privacy');
      expect(useAuthStore.getState().user).toMatchObject({ id: 7, username: 'alice' });
    });

    it('shows a loader while the session is being restored', () => {
      useAuthStore.setState({ isLoading: true });

      renderAppAt('/settings');

      expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
      expect(currentUrl()).toBe('/settings');
    });

    it('opens the dashboard for signed-in users', async () => {
      signIn();

      renderAppAt('/');

      expect(await findHeading('Your dashboard')).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
      await waitFor(() => expect(document.title).toBe('Growth Tracker'));
    });

    it('opens other users’ dashboards', async () => {
      signIn();

      renderAppAt('/user/bob');

      expect(await findHeading('Dashboard of bob')).toBeInTheDocument();
      await waitFor(() => expect(document.title).toBe('@bob · Growth Tracker'));
    });

    it('sends signed-in users away from the login screen', async () => {
      signIn();

      renderAppAt('/login');

      expect(await findHeading('Your dashboard')).toBeInTheDocument();
      expect(currentUrl()).toBe('/');
    });

    it('keeps the password reset flow reachable without signing in', async () => {
      renderAppAt('/forgot-password');

      expect(await findHeading('Forgot your password?')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Growth Tracker home' })).not.toBeInTheDocument();
    });
  });

  describe('challenges', () => {
    it.each([
      ['/challenges', 'Your challenges', 'Challenges · Growth Tracker'],
      ['/challenges/42', 'Challenge 42', 'Challenge · Growth Tracker'],
      ['/c/ABCD2345', 'Invite ABCD2345', 'Join challenge · Growth Tracker'],
    ])('opens %s under the Challenges tab', async (url, heading, title) => {
      signIn();

      renderAppAt(url);

      expect(await findHeading(heading)).toBeInTheDocument();
      expect(currentUrl()).toBe(url);
      expect(screen.getByRole('button', { name: 'Challenges' })).toHaveAttribute(
        'aria-current',
        'page'
      );
      await waitFor(() => expect(document.title).toBe(title));
    });

    it('sends signed-out visitors from an invite link to log in, then back to it', async () => {
      post.mockResolvedValue({
        success: true,
        access_token: tokenWith({ user_id: 7, username: 'alice' }),
      });
      const { user } = renderAppAt('/c/ABCD2345');

      await findHeading('Welcome back');
      expect(currentUrl()).toBe('/login');
      await user.type(screen.getByLabelText('Username or email'), 'alice');
      await user.type(screen.getByLabelText('Password'), 'password123{Enter}');

      expect(await findHeading('Invite ABCD2345')).toBeInTheDocument();
      expect(currentUrl()).toBe('/c/ABCD2345');
    });

    it('brings people who sign up from an invite link back to it', async () => {
      post.mockImplementation(async (endpoint: string) =>
        endpoint === '/register'
          ? { success: true }
          : { success: true, access_token: tokenWith({ user_id: 8, username: 'newbie' }) }
      );
      const { user } = renderAppAt('/c/ABCD2345');

      await findHeading('Welcome back');
      await user.click(screen.getByRole('tab', { name: 'Sign up' }));
      await user.type(screen.getByLabelText('Email'), 'newbie@example.com');
      await user.type(screen.getByLabelText('Username'), 'newbie');
      await user.type(screen.getByLabelText('Password'), 'password123{Enter}');

      expect(await findHeading('Invite ABCD2345')).toBeInTheDocument();
      expect(currentUrl()).toBe('/c/ABCD2345');
      expect(post).toHaveBeenCalledWith('/register', {
        email: 'newbie@example.com',
        username: 'newbie',
        password: 'password123',
      });
    });
  });

  describe('unknown and legacy routes', () => {
    it('redirects unknown routes to Home', async () => {
      signIn();

      renderAppAt('/no/such/page');

      expect(await findHeading('Your dashboard')).toBeInTheDocument();
      expect(currentUrl()).toBe('/');
    });

    it('sends signed-out visitors from unknown routes to the login screen', async () => {
      renderAppAt('/no/such/page');

      expect(await findHeading('Welcome back')).toBeInTheDocument();
      expect(currentUrl()).toBe('/login');
    });

    it.each([
      ['/profile/edit', '/settings', 'Settings'],
      ['/notifications', '/', 'Your dashboard'],
    ])('redirects the old link %s to %s', async (from, to, heading) => {
      signIn();

      renderAppAt(from);

      expect(await findHeading(heading)).toBeInTheDocument();
      expect(currentUrl()).toBe(to);
    });
  });

  it('signs out a stored session whose token has expired on load', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({
        state: { user: { id: 3, username: 'carol' }, isAuthenticated: true },
        version: 0,
      })
    );
    localStorage.setItem(
      STORAGE_KEYS.ACCESS_TOKEN,
      tokenWith({ user_id: 3, username: 'carol', exp: nowInSeconds() - 60 })
    );
    await act(async () => {
      await useAuthStore.persist.rehydrate();
    });

    renderAppAt('/settings');

    expect(await findHeading('Welcome back')).toBeInTheDocument();
    expect(currentUrl()).toBe('/login');
    expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBeNull();
    expect(info).toHaveBeenCalledWith('[Auth] Stored session expired, signing out');
  });

  describe('profile loading', () => {
    it('loads the profile once after sign-in and reminds unverified users', async () => {
      signIn();
      get.mockResolvedValue({
        profile_pic: 'pic.jpg',
        profile_pic_thumb: 'thumb.jpg',
        bio: 'Runner',
        email_verified: false,
      });

      renderAppAt('/');

      expect(await screen.findByText('Verify your email')).toBeInTheDocument();
      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith('/profile');
      expect(useAuthStore.getState().user).toMatchObject({
        profilePic: 'pic.jpg',
        profilePicThumb: 'thumb.jpg',
        bio: 'Runner',
        emailVerified: false,
      });
    });

    it('keeps what it knows when the profile has no extra details', async () => {
      signIn({ bio: 'Existing bio' });

      renderAppAt('/');

      await findHeading('Your dashboard');
      await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      expect(useAuthStore.getState().user).toEqual({
        id: 1,
        username: 'testuser',
        bio: 'Existing bio',
      });
    });

    it('keeps working when the profile cannot be loaded', async () => {
      signIn();
      get.mockRejectedValue(new Error('Network down'));

      renderAppAt('/');

      expect(await findHeading('Your dashboard')).toBeInTheDocument();
      await waitFor(() => expect(get).toHaveBeenCalled());
    });

    it('does not load a profile for signed-out visitors', async () => {
      renderAppAt('/login');

      await findHeading('Welcome back');
      expect(get).not.toHaveBeenCalled();
    });

    it('loads the profile again for the next sign-in', async () => {
      signIn();
      renderAppAt('/');
      await findHeading('Your dashboard');
      expect(get).toHaveBeenCalledTimes(1);

      act(() => useAuthStore.getState().logout());
      expect(await findHeading('Welcome back')).toBeInTheDocument();

      act(() => {
        signIn({ id: 2, username: 'bob' });
      });

      expect(await findHeading('Your dashboard')).toBeInTheDocument();
      expect(get).toHaveBeenCalledTimes(2);
    });
  });

  describe('push on this device', () => {
    const spyOnPushCheck = () => vi.spyOn(usePushStore.getState(), 'checkSupport');

    it('checks the subscription once per signed-in session', async () => {
      const checkSupport = spyOnPushCheck();
      signIn();

      renderAppAt('/');
      await findHeading('Your dashboard');

      expect(checkSupport).toHaveBeenCalledTimes(1);
    });

    it('does not check it for signed-out visitors', async () => {
      const checkSupport = spyOnPushCheck();

      renderAppAt('/login');
      await findHeading('Welcome back');

      expect(checkSupport).not.toHaveBeenCalled();
    });

    it('checks it again for the next person who signs in', async () => {
      const checkSupport = spyOnPushCheck();
      signIn();
      renderAppAt('/');
      await findHeading('Your dashboard');

      act(() => useAuthStore.getState().logout());
      await findHeading('Welcome back');
      act(() => {
        signIn({ id: 2, username: 'bob' });
      });
      await findHeading('Your dashboard');

      expect(checkSupport).toHaveBeenCalledTimes(2);
    });
  });

  it('applies the saved theme on start', async () => {
    useThemeStore.setState({ theme: 'dark' });

    renderAppAt('/login');

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await findHeading('Welcome back');
  });

  it('flushes analytics when the app closes', async () => {
    const { unmount } = renderAppAt('/login');
    await findHeading('Welcome back');

    unmount();

    expect(gl.shutdown).toHaveBeenCalledTimes(1);
  });

  describe('screens that fail to load', () => {
    it('retries once, which recovers from a flaky connection', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      chunks.failures.VerifyEmail = 1;

      renderAppAt('/verify-email');

      expect(await findHeading('Verification failed', 3000)).toBeInTheDocument();
      expect(warn).toHaveBeenCalledWith('[lazyWithRetry] Chunk load failed, retrying', {
        chunkName: 'VerifyEmail',
      });
    });

    it('reloads the page once to pick up a new deployment', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      chunks.failures.ResetPassword = 2;
      window.history.pushState({}, '', '/reset-password');
      const reload = vi.fn();
      vi.stubGlobal('location', { ...window.location, reload });

      render(<App />);

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(warn).toHaveBeenCalledWith('[lazyWithRetry] Reloading to fetch the latest build', {
        chunkName: 'ResetPassword',
      });
      expect(sessionStorage.getItem('gt-chunk-reload-at')).not.toBeNull();
      expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    });

    it('shows the error screen when the screen still cannot load after a reload', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      chunks.failures.AnalyticsPage = 2;
      sessionStorage.setItem('gt-chunk-reload-at', String(Date.now()));
      signIn();

      renderAppAt('/analytics');

      expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
        'Something went wrong'
      );
      expect(consoleError).toHaveBeenCalledWith('[lazyWithRetry] Chunk load failed permanently', {
        chunkName: 'AnalyticsPage',
        error: expect.any(String),
      });
      // The rest of the app keeps working
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    });
  });
});
