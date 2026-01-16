/**
 * Verify Email Page Component
 *
 * Handles email verification from the link sent to user's email.
 * Shows loading, success, or error states with glassmorphism design.
 */

import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Loader2, XCircle, CheckCircle, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../services/api';
import { SnapToast } from './ui';
import { APP_ROUTES, API_ROUTES } from '../constants/routes';
import { useAuth } from '../store';

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
        const res = await api.post<{ success: boolean; message?: string; already_verified?: boolean }>(
          API_ROUTES.AUTH.VERIFY_EMAIL,
          { token }
        );

        if (res.success) {
          if (res.already_verified) {
            setState('already_verified');
          } else {
            setState('success');
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

    setResending(true);
    try {
      await api.post(API_ROUTES.AUTH.RESEND_VERIFICATION, {});
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

  // Loading state
  if (state === 'verifying') {
    return (
      <div className="container" style={{ maxWidth: '360px', marginTop: '3rem' }}>
        <div
          className="glass-panel"
          style={{
            padding: '2rem',
            borderRadius: '16px',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.05) 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1.25rem',
            }}
          >
            <Loader2
              size={28}
              color="var(--accent)"
              style={{ animation: 'spin 1s linear infinite' }}
            />
          </div>
          <h2 style={{ marginBottom: '0.5rem', fontSize: '1.15rem', color: 'var(--text-primary)' }}>
            Verifying Your Email
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            Please wait while we verify your email address...
          </p>
        </div>
        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  // Success state
  if (state === 'success' || state === 'already_verified') {
    return (
      <div className="container" style={{ maxWidth: '360px', marginTop: '3rem' }}>
        <div
          className="glass-panel"
          style={{
            padding: '2rem',
            borderRadius: '16px',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.2) 0%, rgba(34, 197, 94, 0.05) 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1.25rem',
            }}
          >
            <CheckCircle size={28} color="#22c55e" />
          </div>
          <h2 style={{ marginBottom: '0.5rem', fontSize: '1.15rem', color: 'var(--text-primary)' }}>
            {state === 'already_verified' ? 'Already Verified!' : 'Email Verified!'}
          </h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
            {state === 'already_verified'
              ? 'Your email address was already verified.'
              : 'Your email address has been successfully verified.'}
          </p>
          <button
            className="btn btn-primary"
            onClick={handleContinue}
            style={{
              width: '100%',
              padding: '12px 20px',
              borderRadius: '10px',
              fontSize: '0.9rem',
              fontWeight: 600,
              background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
              border: 'none',
              color: '#ffffff',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(34, 197, 94, 0.3)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            Continue to App
          </button>
        </div>
      </div>
    );
  }

  // Error state
  return (
    <div className="container" style={{ maxWidth: '360px', marginTop: '3rem' }}>
      {toast && (
        <SnapToast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
      <div
        className="glass-panel"
        style={{
          padding: '2rem',
          borderRadius: '16px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.15) 0%, rgba(239, 68, 68, 0.05) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1.25rem',
          }}
        >
          <XCircle size={28} color="#ef4444" />
        </div>
        <h2 style={{ marginBottom: '0.5rem', fontSize: '1.15rem', color: 'var(--text-primary)' }}>
          Verification Failed
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
          {errorMessage || 'This verification link is invalid or has expired.'}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {isAuthenticated ? (
            <button
              onClick={handleResendVerification}
              disabled={resending}
              style={{
                width: '100%',
                padding: '12px 20px',
                borderRadius: '10px',
                fontSize: '0.9rem',
                fontWeight: 600,
                background: 'var(--glass-surface-bg)',
                border: '1px solid var(--glass-surface-border)',
                color: 'var(--accent)',
                cursor: resending ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s ease',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                opacity: resending ? 0.7 : 1,
              }}
              onMouseEnter={(e) => {
                if (!resending) {
                  e.currentTarget.style.background = 'var(--glass-hover-bg)';
                  e.currentTarget.style.borderColor = 'var(--accent)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--glass-surface-bg)';
                e.currentTarget.style.borderColor = 'var(--glass-surface-border)';
              }}
            >
              <RefreshCw
                size={16}
                style={{ animation: resending ? 'spin 1s linear infinite' : 'none' }}
              />
              {resending ? 'Sending...' : 'Resend Verification Email'}
            </button>
          ) : (
            <Link to={APP_ROUTES.LOGIN} style={{ textDecoration: 'none', width: '100%' }}>
              <button
                style={{
                  width: '100%',
                  padding: '12px 20px',
                  borderRadius: '10px',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  background: 'var(--glass-surface-bg)',
                  border: '1px solid var(--glass-surface-border)',
                  color: 'var(--accent)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--glass-hover-bg)';
                  e.currentTarget.style.borderColor = 'var(--accent)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--glass-surface-bg)';
                  e.currentTarget.style.borderColor = 'var(--glass-surface-border)';
                }}
              >
                Login
              </button>
            </Link>
          )}

          <Link to={APP_ROUTES.HOME} style={{ textDecoration: 'none', width: '100%' }}>
            <button
              style={{
                width: '100%',
                padding: '10px 16px',
                borderRadius: '8px',
                fontSize: '0.85rem',
                fontWeight: 500,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'color 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-secondary)';
              }}
            >
              Go to Home
            </button>
          </Link>
        </div>
      </div>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
