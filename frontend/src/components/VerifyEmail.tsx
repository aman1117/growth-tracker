/**
 * Verify Email Page Component
 *
 * Handles email verification from the link sent to user's email.
 * Shows verifying, success, or error states on the shared AuthShell.
 */

import { ArrowRight, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { API_ROUTES, APP_ROUTES } from '../constants/routes';
import { api, ApiError } from '../services/api';
import { gl } from '../services/goodlogs';
import { useAuth } from '../store';
import { AuthShell, authStyles } from './auth';
import { SnapToast } from './ui';

type VerificationState = 'verifying' | 'success' | 'error' | 'already_verified';

export const VerifyEmail: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  const { isAuthenticated, updateEmailVerified } = useAuth();

  const [state, setState] = useState<VerificationState>('verifying');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [resending, setResending] = useState(false);

  // Verify email on mount
  useEffect(() => {
    const verifyEmail = async () => {
      if (!token) {
        setState('error');
        setErrorMessage('No verification token provided');
        return;
      }

      try {
        const res = await api.post<{
          success: boolean;
          message?: string;
          already_verified?: boolean;
        }>(API_ROUTES.AUTH.VERIFY_EMAIL, { token });

        if (res.success) {
          if (res.already_verified) {
            setState('already_verified');
          } else {
            setState('success');
            gl.track('email_verified');
          }
          // Update auth store if user is logged in
          updateEmailVerified(true);
          // Dispatch event for banner to hide
          window.dispatchEvent(new Event('email-verified'));
        } else {
          setState('error');
          setErrorMessage(res.message || 'Verification failed');
        }
      } catch (err) {
        setState('error');
        if (err instanceof ApiError) {
          setErrorMessage(err.message);
        } else {
          setErrorMessage('An error occurred during verification');
        }
      }
    };

    verifyEmail();
  }, [token, updateEmailVerified]);

  const handleResendVerification = async () => {
    if (!isAuthenticated) {
      navigate(APP_ROUTES.LOGIN);
      return;
    }
    if (resending) return;

    setResending(true);
    try {
      await api.post(API_ROUTES.AUTH.RESEND_VERIFICATION, {});
      gl.track('email_verification_resent');
      setToast({ message: 'Verification email sent! Check your inbox.', type: 'success' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to send email';
      setToast({ message, type: 'error' });
    } finally {
      setResending(false);
    }
  };

  const handleContinue = () => {
    navigate(APP_ROUTES.HOME);
  };

  const toastElement = toast && (
    <SnapToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
  );

  // Loading state
  if (state === 'verifying') {
    return (
      <AuthShell
        icon={<Loader2 size={30} className={authStyles.spinner} />}
        tone="info"
        title="Verifying your email…"
        subtitle="Please wait while we confirm your address."
        live
      />
    );
  }

  // Success state
  if (state === 'success' || state === 'already_verified') {
    return (
      <AuthShell
        icon={<CheckCircle2 size={30} strokeWidth={2} />}
        tone="success"
        title={state === 'already_verified' ? 'Already verified' : 'Email verified!'}
        subtitle={
          state === 'already_verified'
            ? 'Your email address was already verified. You are all set.'
            : 'Thanks for confirming. Your account is fully unlocked.'
        }
        live
        actions={
          <button className="btn btn-primary" onClick={handleContinue}>
            Continue to app
            <ArrowRight size={18} strokeWidth={2.5} aria-hidden="true" />
          </button>
        }
      />
    );
  }

  // Error state
  return (
    <>
      <AuthShell
        icon={<XCircle size={30} strokeWidth={2} />}
        tone="danger"
        title="Verification failed"
        subtitle={errorMessage || 'This verification link is invalid or has expired.'}
        live
        actions={
          <>
            {isAuthenticated ? (
              <button
                className="btn btn-primary"
                onClick={handleResendVerification}
                disabled={resending}
                aria-busy={resending}
              >
                <RefreshCw
                  size={17}
                  strokeWidth={2.5}
                  className={resending ? authStyles.spinner : undefined}
                  aria-hidden="true"
                />
                {resending ? 'Sending…' : 'Resend verification email'}
              </button>
            ) : (
              <Link to={APP_ROUTES.LOGIN} className="btn btn-primary">
                Log in
              </Link>
            )}

            <Link to={APP_ROUTES.HOME} className={authStyles.ghostButton}>
              Go to home
            </Link>
          </>
        }
      />
      {toastElement}
    </>
  );
};
