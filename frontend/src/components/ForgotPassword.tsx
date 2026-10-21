import { ArrowLeft, Loader2, Mail, MailCheck, Send } from 'lucide-react';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { api, ApiError } from '../services/api';
import { AuthShell, authStyles } from './auth';
import { Input, SnapToast } from './ui';

export const ForgotPassword: React.FC = () => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setToast(null);

    try {
      // The server answers unknown addresses with the same success (security: don't reveal
      // if user exists), so any successful response gets the generic confirmation
      await api.post('/auth/forgot-password', { email });
      setIsSubmitted(true);
    } catch (err) {
      // Only real failures land here (offline, rate limited, server error): no link was sent
      console.warn('[ForgotPassword] Reset link request failed; asking the user to retry', err);
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

  if (isSubmitted) {
    return (
      <AuthShell
        icon={<MailCheck size={30} strokeWidth={2} />}
        tone="success"
        title="Check your inbox"
        subtitle={
          <>
            If an account exists for <span className={authStyles.emphasis}>{email}</span>, a reset
            link is on its way. It expires in 15 minutes.
          </>
        }
        live
        actions={
          <>
            <Link to={APP_ROUTES.LOGIN} className="btn btn-primary">
              Back to log in
            </Link>
            <button
              type="button"
              className={authStyles.ghostButton}
              onClick={() => setIsSubmitted(false)}
            >
              Use a different email
            </button>
          </>
        }
      />
    );
  }

  return (
    <>
      <AuthShell
        icon={<Mail size={30} strokeWidth={2} />}
        title="Forgot your password?"
        subtitle="No worries. Enter your email and we'll send you a reset link."
        footer={backToLogin}
      >
        <form onSubmit={handleSubmit} className={authStyles.form}>
          <Input
            id="forgot-email"
            label="Email address"
            type="email"
            icon={<Mail size={18} strokeWidth={2.25} aria-hidden="true" />}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
          />

          <button
            type="submit"
            className={`btn btn-primary ${authStyles.submit}`}
            disabled={loading}
            aria-busy={loading}
          >
            {loading ? (
              <Loader2 size={18} className={authStyles.spinner} aria-hidden="true" />
            ) : (
              <Send size={17} strokeWidth={2.5} aria-hidden="true" />
            )}
            {loading ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      </AuthShell>

      {toast && (
        <SnapToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </>
  );
};
