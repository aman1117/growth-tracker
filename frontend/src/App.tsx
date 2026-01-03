import React, { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth, useThemeStore } from './store';
import { APP_ROUTES } from './constants/routes';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { Layout } from './components/Layout';
import { LoadingSpinner } from './components/ui';

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

function App() {
  return (
    <ErrorBoundary>
      <ThemeInitializer>
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
      </ThemeInitializer>
    </ErrorBoundary>
  );
}

export default App;
