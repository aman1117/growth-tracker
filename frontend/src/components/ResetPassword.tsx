import { ArrowLeft, CheckCircle2, KeyRound, Link2Off, Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { VALIDATION, VALIDATION_MESSAGES } from '../constants/validation';
import { api, ApiError } from '../services/api';
import { characterCount } from '../utils/text';
import { AuthShell, authStyles } from './auth';
import { PasswordInput, SnapToast } from './ui';

export const ResetPassword: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [isValidating, setIsValidating] = useState(true);
  const [isValidToken, setIsValidToken] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [success, setSuccess] = useState(false);

  // Validate token on mount
  useEffect(() => {
    const validateToken = async () => {
      if (!token) {
        setIsValidating(false);
        setIsValidToken(false);
        return;
      }

      try {
        // Encode so tokens containing '+', '/' or '=' survive the query string intact
        const res = await api.get(
          `/auth/reset-password/validate?token=${encodeURIComponent(token)}`
        );
        setIsValidToken(res.valid === true);
      } catch (error) {
        console.warn('[ResetPassword] Token validation failed; showing expired-link state', error);
        setIsValidToken(false);
      } finally {
        setIsValidating(false);
      }
    };

    validateToken();
  }, [token]);

  const passwordsMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    if (newPassword !== confirmPassword) {
      setToast({ message: 'Passwords do not match', type: 'error' });
      return;
    }

    // Count characters like the server does, so an emoji counts once
    if (characterCount(newPassword) < VALIDATION.PASSWORD_MIN_LENGTH) {
      setToast({ message: VALIDATION_MESSAGES.PASSWORD_LENGTH_ERROR, type: 'error' });
      return;
    }

    setLoading(true);

    try {
      const res = await api.post('/auth/reset-password', {
        token,
        new_password: newPassword,
        confirm_password: confirmPassword,
      });

      if (res.success) {
        setSuccess(true);
      } else {
        setToast({ message: res.error || 'Failed to reset password', type: 'error' });
      }
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'An error occurred. Please try again.';
      setToast({ message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const backToLogin = (
    <Link to={APP_ROUTES.LOGIN} className={authStyles.backLink}>
      <ArrowLeft size={16} strokeWidth={2.5} aria-hidden="true" />
      Back to log in
    </Link>
  );

  // Loading state
  if (isValidating) {
    return (
      <AuthShell
        icon={<Loader2 size={30} className={authStyles.spinner} />}
        tone="info"
        title="Checking your link…"
        subtitle="Hang tight, this only takes a moment."
        live
      />
    );
  }

  // Invalid or expired token
  if (!isValidToken) {
    return (
      <AuthShell
        icon={<Link2Off size={30} strokeWidth={2} />}
        tone="danger"
        title="This link has expired"
        subtitle="Reset links are valid for 15 minutes. Request a fresh one and you'll be back in no time."
        live
        actions={
          <Link to={APP_ROUTES.FORGOT_PASSWORD} className="btn btn-primary">
            Request a new link
          </Link>
        }
        footer={backToLogin}
      />
    );
  }

  // Success state
  if (success) {
    return (
      <AuthShell
        icon={<CheckCircle2 size={30} strokeWidth={2} />}
        tone="success"
        title="Password updated!"
        subtitle="You can now log in with your new password."
        live
        actions={
          <button className="btn btn-primary" onClick={() => navigate(APP_ROUTES.LOGIN)}>
            Go to log in
          </button>
        }
      />
    );
  }

  // Reset form
  return (
    <>
      <AuthShell
        icon={<KeyRound size={30} strokeWidth={2} />}
        title="Set a new password"
        subtitle="Choose something you haven't used before, at least 8 characters."
        footer={backToLogin}
      >
        <form onSubmit={handleSubmit} className={authStyles.form}>
          <PasswordInput
            id="reset-new-password"
            label="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            required
            minLength={8}
          />

          <PasswordInput
            id="reset-confirm-password"
            label="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Type it again"
            autoComplete="new-password"
            required
            minLength={8}
            error={passwordsMismatch ? "Passwords don't match yet" : undefined}
            aria-invalid={passwordsMismatch || undefined}
          />

          <button
            type="submit"
            className={`btn btn-primary ${authStyles.submit}`}
            disabled={loading}
            aria-busy={loading}
          >
            {loading && <Loader2 size={18} className={authStyles.spinner} aria-hidden="true" />}
            {loading ? 'Saving…' : 'Reset password'}
          </button>
        </form>
      </AuthShell>

      {toast && (
        <SnapToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </>
  );
};
