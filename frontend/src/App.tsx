import React, { Suspense, lazy, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth, useThemeStore } from './store';
import { APP_ROUTES } from './constants/routes';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { Layout } from './components/Layout';
import { LoadingSpinner } from './components/ui';
import { api } from './services/api';

// Lazy load route components for code splitting
const AuthForm = lazy(() => import('./components/AuthForm').then(m => ({ default: m.AuthForm })));
const Dashboard = lazy(() => import('./components/Dashboard').then(m => ({ default: m.Dashboard })));
const ForgotPassword = lazy(() => import('./components/ForgotPassword').then(m => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import('./components/ResetPassword').then(m => ({ default: m.ResetPassword })));
const SettingsPage = lazy(() => import('./components/SettingsPage').then(m => ({ default: m.SettingsPage })));
const AnalyticsPage = lazy(() => import('./components/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));

/**
 * Loading fallback component for Suspense
 */
const PageLoader: React.FC = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
    <LoadingSpinner size="lg" />
  </div>
);

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <PageLoader />;
  }

  if (!isAuthenticated) {
    return <Navigate to={APP_ROUTES.LOGIN} />;
  }

  return <>{children}</>;
};

/**
 * Theme initializer component - initializes theme on app mount
 */
const ThemeInitializer: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initializeTheme = useThemeStore((state) => state.initializeTheme);

  useEffect(() => {
    initializeTheme();
  }, [initializeTheme]);

  return <>{children}</>;
};

/**
 * Profile initializer component - fetches user profile on app load when authenticated
 * This ensures the profile picture is available in the nav without visiting settings
 */
const ProfileInitializer: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading, updateProfilePic, updateBio } = useAuth();
  const hasFetched = useRef(false);

  useEffect(() => {
    // Fetch profile once per session when authenticated
    if (isAuthenticated && !isLoading && !hasFetched.current) {
      hasFetched.current = true;
      api.get<{ profile_pic?: string; bio?: string }>('/profile')
        .then(data => {
          if (data?.profile_pic) {
            updateProfilePic(data.profile_pic);
          }
          if (data?.bio) {
            updateBio(data.bio);
          }
        })
        .catch(() => {
          // Silently fail - profile data is not critical for app function
        });
    }
  }, [isAuthenticated, isLoading, updateProfilePic, updateBio]);

  // Reset fetch flag on logout so it fetches again on next login
  useEffect(() => {
    if (!isAuthenticated) {
      hasFetched.current = false;
    }
  }, [isAuthenticated]);

  return <>{children}</>;
};

function App() {
  return (
    <ErrorBoundary>
      <ThemeInitializer>
        <ProfileInitializer>
          <Router>
            <Layout>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path={APP_ROUTES.LOGIN} element={<AuthForm />} />
                <Route path={APP_ROUTES.FORGOT_PASSWORD} element={<ForgotPassword />} />
                <Route path={APP_ROUTES.RESET_PASSWORD} element={<ResetPassword />} />
                <Route
                  path={APP_ROUTES.HOME}
                  element={
                    <ProtectedRoute>
                      <ErrorBoundary>
                        <Dashboard />
                      </ErrorBoundary>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/user/:username"
                  element={
                    <ProtectedRoute>
                      <ErrorBoundary>
                        <Dashboard />
                      </ErrorBoundary>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path={APP_ROUTES.SETTINGS}
                  element={
                    <ProtectedRoute>
                      <ErrorBoundary>
                        <SettingsPage />
                      </ErrorBoundary>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path={APP_ROUTES.ANALYTICS}
                  element={
                    <ProtectedRoute>
                      <ErrorBoundary>
                        <AnalyticsPage />
                      </ErrorBoundary>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/analytics/:username"
                  element={
                    <ProtectedRoute>
                      <ErrorBoundary>
                        <AnalyticsPage />
                      </ErrorBoundary>
                    </ProtectedRoute>
                  }
                />
              </Routes>
            </Suspense>
          </Layout>
        </Router>
        </ProfileInitializer>
      </ThemeInitializer>
    </ErrorBoundary>
  );
}

export default App;
