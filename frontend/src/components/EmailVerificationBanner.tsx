/**
 * Email Verification Banner Component
 *
 * Shows a glassmorphism banner when the user's email is not verified.
 * Provides a resend button with cooldown handling.
 * Works with both light and dark themes.
 */

import React, { useState, useEffect } from 'react';
import { Mail, X, RefreshCw, CheckCircle } from 'lucide-react';
import { useAuth } from '../store';
import { api } from '../services/api';
import { API_ROUTES } from '../constants/routes';

type BannerState = 'visible' | 'resending' | 'sent' | 'dismissed' | 'hidden';

export const EmailVerificationBanner: React.FC = () => {
  const { user, isAuthenticated, updateEmailVerified } = useAuth();
  const [bannerState, setBannerState] = useState<BannerState>('hidden');
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Determine banner visibility based on auth state and email verification
  useEffect(() => {
    if (isAuthenticated && user && user.emailVerified === false) {
      setBannerState('visible');
    } else {
      setBannerState('hidden');
    }
  }, [isAuthenticated, user, user?.emailVerified]);

  // Cooldown timer
  useEffect(() => {
    if (cooldownRemaining > 0) {
      const timer = setTimeout(() => {
        setCooldownRemaining(prev => prev - 1);
      }, 1000);
      return () => clearTimeout(timer);
    } else if (bannerState === 'sent') {
      // Reset to visible state after cooldown ends
      setBannerState('visible');
    }
  }, [cooldownRemaining, bannerState]);

  const handleResend = async () => {
    if (cooldownRemaining > 0 || bannerState === 'resending') return;

    setBannerState('resending');
    setErrorMessage(null);

    try {
      await api.post(API_ROUTES.AUTH.RESEND_VERIFICATION, {});
      setBannerState('sent');
      setCooldownRemaining(120); // 2 minute cooldown
    } catch (error: unknown) {
      setBannerState('visible');
      // Handle rate limit error
      if (error instanceof Error && error.message.includes('cooldown')) {
        setErrorMessage('Please wait before requesting another email');
        setCooldownRemaining(120);
      } else {
        setErrorMessage('Failed to send email. Please try again.');
      }
    }
  };

  const handleDismiss = () => {
    setBannerState('dismissed');
    // Store dismissal timestamp - will show again after 24 hours
    localStorage.setItem('email-verification-dismissed-at', Date.now().toString());
  };

  // Check for dismissal on mount (reappear after 24 hours)
  useEffect(() => {
    const dismissedAt = localStorage.getItem('email-verification-dismissed-at');
    if (dismissedAt && bannerState === 'visible') {
      const dismissedTime = parseInt(dismissedAt, 10);
      const oneDayMs = 24 * 60 * 60 * 1000; // 24 hours
      if (Date.now() - dismissedTime < oneDayMs) {
        setBannerState('dismissed');
      } else {
        // Clear old dismissal
        localStorage.removeItem('email-verification-dismissed-at');
      }
    }
  }, [bannerState]);

  // Handle verification completion (from VerifyEmail page)
  useEffect(() => {
    const handleVerified = () => {
      updateEmailVerified(true);
    };

    window.addEventListener('email-verified', handleVerified);
    return () => window.removeEventListener('email-verified', handleVerified);
  }, [updateEmailVerified]);

  if (bannerState === 'hidden' || bannerState === 'dismissed') {
    return null;
  }

  const isSent = bannerState === 'sent';
  const isResending = bannerState === 'resending';

  return (
    <div
      className="email-verification-banner"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        background: isSent
          ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.95) 0%, rgba(22, 163, 74, 0.95) 100%)'
          : 'linear-gradient(135deg, var(--glass-surface-bg) 0%, var(--glass-panel-bg) 100%)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--glass-surface-border)',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        fontSize: '13px',
        fontWeight: 500,
        zIndex: 9998,
        fontFamily: "var(--font-sans)",
        color: isSent ? '#ffffff' : 'var(--text-primary)',
        boxShadow: '0 2px 12px rgba(0, 0, 0, 0.08)',
        transition: 'all 0.3s ease',
        flexWrap: 'wrap',
      }}
    >
      {/* Icon */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          borderRadius: '8px',
          background: isSent
            ? 'rgba(255, 255, 255, 0.2)'
            : 'linear-gradient(135deg, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.05) 100%)',
          flexShrink: 0,
        }}
      >
        {isSent ? (
          <CheckCircle size={16} style={{ color: '#ffffff' }} />
        ) : (
          <Mail size={16} style={{ color: 'var(--accent)' }} />
        )}
      </div>

      {/* Message */}
      <span style={{ 
        flex: 1,
        minWidth: 0,
      }}>
        {isSent ? (
          'Verification email sent! Check your inbox.'
        ) : errorMessage ? (
          <span style={{ color: 'var(--error)' }}>{errorMessage}</span>
        ) : (
          <>
            <strong>Verify your email</strong>
            <br />
            <span style={{ color: 'var(--text-muted)', fontSize: '12px', fontWeight: 400 }}>
              Check inbox for verification link
            </span>
          </>
        )}
      </span>

      {/* Resend Button */}
      {!isSent && (
        <button
          onClick={handleResend}
          disabled={isResending || cooldownRemaining > 0}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 14px',
            borderRadius: '8px',
            border: '1px solid var(--glass-surface-border)',
            background: 'var(--glass-surface-bg)',
            color: isResending || cooldownRemaining > 0 ? 'var(--text-muted)' : 'var(--accent)',
            fontSize: '12px',
            fontWeight: 600,
            cursor: isResending || cooldownRemaining > 0 ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s ease',
            whiteSpace: 'nowrap',
            opacity: isResending || cooldownRemaining > 0 ? 0.7 : 1,
          }}
          onMouseEnter={(e) => {
            if (!isResending && cooldownRemaining === 0) {
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
            size={14}
            style={{
              animation: isResending ? 'spin 1s linear infinite' : 'none',
            }}
          />
          {cooldownRemaining > 0
            ? `Resend (${Math.floor(cooldownRemaining / 60)}:${(cooldownRemaining % 60).toString().padStart(2, '0')})`
            : isResending
            ? 'Sending...'
            : 'Resend'}
        </button>
      )}

      {/* Dismiss Button */}
      <button
        onClick={handleDismiss}
        style={{
          background: 'transparent',
          border: 'none',
          color: isSent ? 'rgba(255, 255, 255, 0.8)' : 'var(--text-muted)',
          cursor: 'pointer',
          padding: '4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '6px',
          transition: 'all 0.2s ease',
          flexShrink: 0,
          marginLeft: '4px',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = isSent
            ? 'rgba(255, 255, 255, 0.15)'
            : 'var(--icon-btn-bg)';
          e.currentTarget.style.color = isSent ? '#ffffff' : 'var(--text-primary)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = isSent ? 'rgba(255, 255, 255, 0.8)' : 'var(--text-muted)';
        }}
        aria-label="Dismiss verification banner"
      >
        <X size={16} />
      </button>

      {/* Keyframe animation for spinner */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
