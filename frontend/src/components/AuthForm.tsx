import { ArrowRight, AtSign, Loader2, Mail, User } from 'lucide-react';
import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { api, ApiError } from '../services/api';
import { useAuth } from '../store';
import { decodeAccessToken } from '../utils/jwt';
import { getSafeRedirectPath, type RedirectState } from '../utils/navigation';
import { AuthShell, authStyles } from './auth';
import { Input, PasswordInput, SnapToast, Tabs } from './ui';

type AuthMode = 'login' | 'register';

const MODE_TABS = [
  { id: 'login', label: 'Log in' },
  { id: 'register', label: 'Sign up' },
];

const FIELD_ICON_PROPS = { size: 18, strokeWidth: 2.25, 'aria-hidden': true } as const;

export const AuthForm: React.FC = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Where to go after signing in: the page that required auth, or Home
  const redirectTo = getSafeRedirectPath((location.state as RedirectState | null)?.from);

  // Username validation: lowercase letters, numbers, underscore, dot only
  const isValidUsername = (name: string) => /^[a-z0-9_.]+$/.test(name);

  // Sanitize input by trimming whitespace
  const sanitizeInput = (value: string) => value.trim();

  const switchMode = (mode: AuthMode) => {
    if (loading) return;
    setIsLogin(mode === 'login');
    setToast(null);
  };

  /**
   * Stores the session from a login response and leaves the auth screen.
   * `replace` keeps the login page out of history so Back never returns to it.
   */
  const completeLogin = (accessToken: unknown): boolean => {
    const payload = decodeAccessToken(accessToken);
    if (!payload || typeof accessToken !== 'string') {
      console.error('[AuthForm] Received malformed access token');
      return false;
    }
    login(accessToken, payload.username, payload.user_id);
    navigate(redirectTo, { replace: true });
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);

    // Sanitize inputs before submission
    const sanitizedUsername = sanitizeInput(username);
    const sanitizedEmail = sanitizeInput(email);

    // Update state with sanitized values
    setUsername(sanitizedUsername);
    setEmail(sanitizedEmail);

    // Validate username format on registration
    if (!isLogin && !isValidUsername(sanitizedUsername)) {
      setToast({
        message: 'Username can only contain lowercase letters, numbers, _ and .',
        type: 'error',
      });
      setLoading(false);
      return;
    }

    try {
      if (isLogin) {
        // Login
        const res = await api.post('/login', { identifier: sanitizedUsername, password });
        if (res.success) {
          if (!completeLogin(res.access_token)) {
            setToast({ message: 'Login failed. Please try again.', type: 'error' });
          }
        } else {
          setToast({ message: res.error || 'Login failed', type: 'error' });
        }
      } else {
        // Register
        const res = await api.post('/register', {
          email: sanitizedEmail,
          username: sanitizedUsername,
          password,
        });
        if (res.success) {
          // Auto login
          const loginRes = await api.post('/login', { identifier: sanitizedUsername, password });
          if (!loginRes.success || !completeLogin(loginRes.access_token)) {
            setIsLogin(true);
            setToast({ message: 'Registration successful, please login.', type: 'success' });
          }
        } else {
          setToast({ message: res.error || 'Registration failed', type: 'error' });
        }
      }
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'An error occurred. Please try again.';
      setToast({ message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const submitLabel = loading
    ? isLogin
      ? 'Logging in…'
      : 'Creating account…'
    : isLogin
      ? 'Log in'
      : 'Create account';

  return (
    <>
      <AuthShell
        title={isLogin ? 'Welcome back' : 'Start growing'}
        subtitle={
          isLogin
            ? 'Log in to keep your streak glowing.'
            : 'Track your hours, build streaks and cheer on friends.'
        }
      >
        <Tabs
          tabs={MODE_TABS}
          activeTab={isLogin ? 'login' : 'register'}
          onTabChange={(id) => switchMode(id as AuthMode)}
          fullWidth
          size="lg"
          className={authStyles.modeSwitch}
        />

        <form onSubmit={handleSubmit} className={authStyles.form}>
          {!isLogin && (
            <Input
              id="auth-email"
              label="Email"
              type="email"
              icon={<Mail {...FIELD_ICON_PROPS} />}
              value={email}
              onChange={(e) => setEmail(e.target.value.trimStart())}
              onBlur={(e) => setEmail(e.target.value.trim())}
              autoComplete="email"
              placeholder="you@example.com"
              required
            />
          )}

          {isLogin ? (
            // Backend accepts either a username or an email address as the login identifier
            <Input
              id="auth-identifier"
              label="Username or email"
              type="text"
              icon={<User {...FIELD_ICON_PROPS} />}
              value={username}
              onChange={(e) => {
                const value = e.target.value.trimStart();
                setUsername(value.includes('@') ? value : value.toLowerCase());
              }}
              onBlur={(e) => setUsername(e.target.value.trim())}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          ) : (
            <Input
              id="auth-identifier"
              label="Username"
              type="text"
              icon={<AtSign {...FIELD_ICON_PROPS} />}
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().trimStart())}
              onBlur={(e) => setUsername(e.target.value.trim())}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              pattern="[a-z0-9_.]+"
              title="Only lowercase letters, numbers, underscore and dot allowed"
              placeholder="e.g. john_doe"
              helperText="Lowercase letters, numbers, _ and . only"
            />
          )}

          <PasswordInput
            id="auth-password"
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            required
            minLength={8}
            helperText={isLogin ? undefined : 'At least 8 characters'}
          />

          {isLogin && (
            <div className={authStyles.fieldAside}>
              <Link to={APP_ROUTES.FORGOT_PASSWORD} className={authStyles.textLink}>
                Forgot password?
              </Link>
            </div>
          )}

          <button
            type="submit"
            className={`btn btn-primary ${authStyles.submit}`}
            disabled={loading}
            aria-busy={loading}
          >
            {loading ? (
              <Loader2 size={18} className={authStyles.spinner} aria-hidden="true" />
            ) : null}
            {submitLabel}
            {!loading && <ArrowRight size={18} strokeWidth={2.5} aria-hidden="true" />}
          </button>
        </form>
      </AuthShell>

      {toast && (
        <SnapToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </>
  );
};
