import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { api, ApiError } from '../services/api';
import { useAuth } from '../store';
import { SnapToast } from './ui';

export const AuthForm: React.FC = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const { login } = useAuth();
  const navigate = useNavigate();

  // Username validation: lowercase letters, numbers, underscore, dot only
  const isValidUsername = (name: string) => /^[a-z0-9_.]+$/.test(name);

  // Sanitize input by trimming whitespace
  const sanitizeInput = (value: string) => value.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
          const token = res.access_token;
          const payload = JSON.parse(atob(token.split('.')[1]));
          login(token, payload.username, payload.user_id);
          navigate(APP_ROUTES.HOME);
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
          if (loginRes.success) {
            const token = loginRes.access_token;
            const payload = JSON.parse(atob(token.split('.')[1]));
            login(token, payload.username, payload.user_id);
            navigate(APP_ROUTES.HOME);
          } else {
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

  return (
    <div className="container" style={{ maxWidth: '320px', marginTop: '2.5rem' }}>
      <div className="card">
        <h2 className="text-center" style={{ marginBottom: '0.75rem', fontSize: '1.1rem' }}>
          {isLogin ? 'Welcome Back' : 'Create Account'}
        </h2>

        <form onSubmit={handleSubmit}>
          {!isLogin && (
            <div className="input-group">
              <label className="input-label">Email</label>
              <input
                type="email"
                className="input-field"
                value={email}
                onChange={(e) => setEmail(e.target.value.trimStart())}
                onBlur={(e) => setEmail(e.target.value.trim())}
                required
              />
            </div>
          )}

          <div className="input-group">
            <label className="input-label">Username</label>
            <input
              type="text"
              className="input-field"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().trimStart())}
              onBlur={(e) => setUsername(e.target.value.trim())}
              required
              pattern="[a-z0-9_.]+"
              title="Only lowercase letters, numbers, underscore and dot allowed"
              placeholder={isLogin ? '' : 'e.g. john_doe'}
            />
          </div>

          <div className="input-group">
            <label className="input-label">Password</label>
            <input
              type="password"
              className="input-field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Processing...' : isLogin ? 'Login' : 'Register'}
          </button>

          {isLogin && (
            <div style={{ marginTop: '0.75rem', textAlign: 'center' }}>
              <Link
                to="/forgot-password"
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-muted)',
                  textDecoration: 'none',
                }}
              >
                Forgot password?
              </Link>
            </div>
          )}
        </form>

        <div style={{ marginTop: '0.5rem', textAlign: 'center' }}>
          <button
            className="btn-outline"
            style={{ border: 'none', fontSize: '0.75rem', color: 'var(--text-secondary)' }}
            onClick={() => {
              setIsLogin(!isLogin);
              setToast(null);
            }}
          >
            {isLogin ? "Don't have an account? Register" : 'Already have an account? Login'}
          </button>
        </div>
      </div>
      {toast && (
        <SnapToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </div>
  );
};
