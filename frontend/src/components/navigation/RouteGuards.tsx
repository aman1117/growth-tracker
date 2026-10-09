/**
 * Route Guards
 *
 * - ProtectedRoute: requires a session; remembers where the user was heading so
 *   login can send them back there (deep links, notification links, shared URLs).
 * - PublicOnlyRoute: screens like Login that make no sense once signed in.
 *
 * Redirects use `replace` so the guard hop never becomes a dead Back entry.
 */

import type { FC, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import { useAuth } from '../../store';
import { getSafeRedirectPath, type RedirectState } from '../../utils/navigation';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { LoadingSpinner } from '../ui';

export const RouteLoader: FC = () => (
  <div
    role="status"
    aria-label="Loading"
    style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}
  >
    <LoadingSpinner size="lg" />
  </div>
);

export const ProtectedRoute: FC<{ children: ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <RouteLoader />;

  if (!isAuthenticated) {
    const state: RedirectState = {
      from: `${location.pathname}${location.search}${location.hash}`,
    };
    return <Navigate to={APP_ROUTES.LOGIN} replace state={state} />;
  }

  // Reset a crashed screen when the user navigates elsewhere (e.g. via the tab bar)
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
};

export const PublicOnlyRoute: FC<{ children: ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <RouteLoader />;

  if (isAuthenticated) {
    const from = (location.state as RedirectState | null)?.from;
    return <Navigate to={getSafeRedirectPath(from)} replace />;
  }

  return <>{children}</>;
};
