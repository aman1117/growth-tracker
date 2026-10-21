import { act, screen } from '@testing-library/react';
import { Route, Routes, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../../store';
import { createNavigator, renderWithHistory, signOut } from '../../test/fixtures/shell';
import { signIn } from '../../test/utils';
import * as navigation from './index';
import { ProtectedRoute, PublicOnlyRoute, RouteLoader } from './RouteGuards';

function Profile() {
  const { username } = useParams();
  if (username === 'broken') throw new Error('Profile crashed');
  return <h1>Profile of {username}</h1>;
}

/** Renders the guarded app routes and returns a handle to navigate like the user would. */
const renderRoutes = (entries: Parameters<typeof renderWithHistory>[1]['entries']) => {
  const navigator = createNavigator();
  const view = renderWithHistory(
    <>
      {navigator.element}
      <Routes>
        <Route path="/about" element={<h1>About page</h1>} />
        <Route
          path="/login"
          element={
            <PublicOnlyRoute>
              <h1>Login page</h1>
            </PublicOnlyRoute>
          }
        />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <h1>Home page</h1>
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <h1>Settings page</h1>
            </ProtectedRoute>
          }
        />
        <Route
          path="/user/:username"
          element={
            <ProtectedRoute>
              <Profile />
            </ProtectedRoute>
          }
        />
      </Routes>
    </>,
    { entries }
  );
  return { ...view, navigate: navigator.go };
};

const location = () => screen.getByTestId('location');
const redirectState = () => JSON.parse(location().getAttribute('data-state') ?? 'null');

describe('RouteLoader', () => {
  it('announces that the screen is loading', () => {
    renderWithHistory(<RouteLoader />, { entries: ['/'] });

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });
});

describe('ProtectedRoute', () => {
  beforeEach(() => {
    signOut();
  });

  it('shows a loader while the session is being restored', () => {
    useAuthStore.setState({ isLoading: true });

    renderRoutes(['/settings']);

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(location()).toHaveTextContent('/settings');
  });

  it('sends signed-out visitors to login, remembering where they were heading', () => {
    renderRoutes(['/settings?tab=privacy#danger']);

    expect(screen.getByRole('heading', { name: 'Login page' })).toBeInTheDocument();
    expect(location()).toHaveTextContent('/login');
    expect(redirectState()).toEqual({ from: '/settings?tab=privacy#danger' });
  });

  it('replaces the guarded entry so Back does not bounce through it', () => {
    const { navigate } = renderRoutes(['/about', '/settings']);
    expect(location()).toHaveTextContent('/login');

    navigate(-1);

    expect(screen.getByRole('heading', { name: 'About page' })).toBeInTheDocument();
  });

  it('renders the screen for signed-in users', () => {
    signIn();

    renderRoutes(['/settings']);

    expect(screen.getByRole('heading', { name: 'Settings page' })).toBeInTheDocument();
  });

  it('contains a crashing screen and recovers when the user navigates elsewhere', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    signIn();
    const { navigate } = renderRoutes(['/user/broken']);

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');

    navigate('/user/alice');

    expect(screen.getByRole('heading', { name: 'Profile of alice' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('PublicOnlyRoute', () => {
  beforeEach(() => {
    signOut();
  });

  it('shows a loader while the session is being restored', () => {
    useAuthStore.setState({ isLoading: true });

    renderRoutes(['/login']);

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows the screen to signed-out visitors', () => {
    renderRoutes(['/login']);

    expect(screen.getByRole('heading', { name: 'Login page' })).toBeInTheDocument();
  });

  it('sends signed-in users home', () => {
    signIn();

    renderRoutes(['/login']);

    expect(screen.getByRole('heading', { name: 'Home page' })).toBeInTheDocument();
    expect(location()).toHaveTextContent(/^\/$/);
  });

  it('sends signed-in users on to the page that required login', () => {
    signIn();

    renderRoutes([{ pathname: '/login', state: { from: '/settings?tab=privacy' } }]);

    expect(screen.getByRole('heading', { name: 'Settings page' })).toBeInTheDocument();
    expect(location()).toHaveTextContent('/settings?tab=privacy');
  });

  it.each(['//evil.example/phish', 'https://evil.example', '/verify-email?token=abc'])(
    'ignores the unsafe or looping redirect target %s',
    (from) => {
      signIn();

      renderRoutes([{ pathname: '/login', state: { from } }]);

      expect(screen.getByRole('heading', { name: 'Home page' })).toBeInTheDocument();
    }
  );

  it('lets a visitor in once they sign in on the login screen', () => {
    renderRoutes([{ pathname: '/login', state: { from: '/user/alice' } }]);
    expect(screen.getByRole('heading', { name: 'Login page' })).toBeInTheDocument();

    act(() => {
      signIn();
    });

    expect(screen.getByRole('heading', { name: 'Profile of alice' })).toBeInTheDocument();
  });
});

describe('navigation barrel', () => {
  it('exports the guards, the loader and the navigation manager', () => {
    expect(navigation.ProtectedRoute).toBe(ProtectedRoute);
    expect(navigation.PublicOnlyRoute).toBe(PublicOnlyRoute);
    expect(navigation.RouteLoader).toBe(RouteLoader);
    expect(navigation.NavigationManager).toEqual(expect.any(Function));
  });
});
