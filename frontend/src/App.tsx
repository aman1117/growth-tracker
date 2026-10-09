import React, { Suspense, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom';

import { ErrorBoundary } from './components/common/ErrorBoundary';
import { EmailVerificationBanner } from './components/EmailVerificationBanner';
import { GoodLogsProvider } from './components/GoodLogsProvider';
import { Layout } from './components/Layout';
import {
  NavigationManager,
  ProtectedRoute,
  PublicOnlyRoute,
  RouteLoader,
} from './components/navigation';
import { OfflineBanner } from './components/OfflineBanner';
import { PWAUpdatePrompt } from './components/PWAUpdatePrompt';
import { APP_ROUTES } from './constants/routes';
import { api } from './services/api';
import { useAuth, useThemeStore } from './store';
import { lazyWithRetry } from './utils/lazyWithRetry';

// Lazy load route components for code splitting (with stale-deploy recovery)
const AuthForm = lazyWithRetry(
  () => import('./components/AuthForm').then((m) => ({ default: m.AuthForm })),
  'AuthForm'
);
const Dashboard = lazyWithRetry(
  () => import('./components/Dashboard').then((m) => ({ default: m.Dashboard })),
  'Dashboard'
);
const ForgotPassword = lazyWithRetry(
  () => import('./components/ForgotPassword').then((m) => ({ default: m.ForgotPassword })),
  'ForgotPassword'
);
const ResetPassword = lazyWithRetry(
  () => import('./components/ResetPassword').then((m) => ({ default: m.ResetPassword })),
  'ResetPassword'
);
const VerifyEmail = lazyWithRetry(
  () => import('./components/VerifyEmail').then((m) => ({ default: m.VerifyEmail })),
  'VerifyEmail'
);
const SettingsPage = lazyWithRetry(
  () => import('./components/SettingsPage').then((m) => ({ default: m.SettingsPage })),
  'SettingsPage'
);
const AnalyticsPage = lazyWithRetry(
  () => import('./components/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })),
  'AnalyticsPage'
);

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
  const { isAuthenticated, isLoading, updateProfilePic, updateBio, updateEmailVerified } =
    useAuth();
  const hasFetched = useRef(false);

  useEffect(() => {
    // Fetch profile once per session when authenticated
    if (isAuthenticated && !isLoading && !hasFetched.current) {
      hasFetched.current = true;
      api
        .get<{
          profile_pic?: string;
          profile_pic_thumb?: string;
          bio?: string;
          email_verified?: boolean;
        }>('/profile')
        .then((data) => {
          if (data?.profile_pic) {
            updateProfilePic(data.profile_pic, data.profile_pic_thumb);
          }
          if (data?.bio) {
            updateBio(data.bio);
          }
          // Update email verification status
          if (data?.email_verified !== undefined) {
            updateEmailVerified(data.email_verified);
          }
        })
        .catch(() => {
          // Silently fail - profile data is not critical for app function
        });
    }
  }, [isAuthenticated, isLoading, updateProfilePic, updateBio, updateEmailVerified]);

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
      <GoodLogsProvider>
        <ThemeInitializer>
          <ProfileInitializer>
            <OfflineBanner />
            <EmailVerificationBanner />
            <PWAUpdatePrompt />
            <Router>
              <NavigationManager />
              <Layout>
                <Suspense fallback={<RouteLoader />}>
                  <Routes>
                    <Route
                      path={APP_ROUTES.LOGIN}
                      element={
                        <PublicOnlyRoute>
                          <AuthForm />
                        </PublicOnlyRoute>
                      }
                    />
                    <Route path={APP_ROUTES.FORGOT_PASSWORD} element={<ForgotPassword />} />
                    <Route path={APP_ROUTES.RESET_PASSWORD} element={<ResetPassword />} />
                    <Route path={APP_ROUTES.VERIFY_EMAIL} element={<VerifyEmail />} />
                    <Route
                      path={APP_ROUTES.HOME}
                      element={
                        <ProtectedRoute>
                          <Dashboard />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/user/:username"
                      element={
                        <ProtectedRoute>
                          <Dashboard />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path={APP_ROUTES.SETTINGS}
                      element={
                        <ProtectedRoute>
                          <SettingsPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path={APP_ROUTES.ANALYTICS}
                      element={
                        <ProtectedRoute>
                          <AnalyticsPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/analytics/:username"
                      element={
                        <ProtectedRoute>
                          <AnalyticsPage />
                        </ProtectedRoute>
                      }
                    />
                    {/* Aliases for deep links sent by push notifications / older clients */}
                    <Route
                      path="/profile/*"
                      element={<Navigate to={APP_ROUTES.SETTINGS} replace />}
                    />
                    <Route
                      path="/notifications"
                      element={<Navigate to={APP_ROUTES.HOME} replace />}
                    />
                    <Route path="*" element={<Navigate to={APP_ROUTES.HOME} replace />} />
                  </Routes>
                </Suspense>
              </Layout>
            </Router>
          </ProfileInitializer>
        </ThemeInitializer>
      </GoodLogsProvider>
    </ErrorBoundary>
  );
}

export default App;
