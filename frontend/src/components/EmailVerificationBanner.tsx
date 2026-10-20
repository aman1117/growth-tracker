/**
 * Email Verification Banner Component
 *
 * Reminds signed-in users with an unverified email to verify it.
 * Provides a resend action with cooldown handling and a 24h dismissal.
 */

import { CheckCircle, Mail, RefreshCw } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { API_ROUTES } from '../constants/routes';
import { api } from '../services/api';
import { useAuth } from '../store';
import { Notice } from './ui';

type BannerState = 'visible' | 'resending' | 'sent' | 'dismissed' | 'hidden';

const DISMISSED_AT_KEY = 'email-verification-dismissed-at';
const RESEND_COOLDOWN_SECONDS = 120;
const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000;

const formatCooldown = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;

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
        setCooldownRemaining((prev) => prev - 1);
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
      setCooldownRemaining(RESEND_COOLDOWN_SECONDS);
    } catch (error: unknown) {
      console.warn('[EmailVerificationBanner] Resend failed', error);
      setBannerState('visible');
      // Handle rate limit error
      if (error instanceof Error && error.message.includes('cooldown')) {
        setErrorMessage('Please wait before requesting another email');
        setCooldownRemaining(RESEND_COOLDOWN_SECONDS);
      } else {
        setErrorMessage('Failed to send email. Please try again.');
      }
    }
  };

  const handleDismiss = () => {
    setBannerState('dismissed');
    // Store dismissal timestamp - will show again after 24 hours
    localStorage.setItem(DISMISSED_AT_KEY, Date.now().toString());
  };

  // Check for dismissal on mount (reappear after 24 hours)
  useEffect(() => {
    const dismissedAt = localStorage.getItem(DISMISSED_AT_KEY);
    if (dismissedAt && bannerState === 'visible') {
      const dismissedTime = parseInt(dismissedAt, 10);
      if (Date.now() - dismissedTime < DISMISS_DURATION_MS) {
        setBannerState('dismissed');
      } else {
        // Clear old dismissal
        localStorage.removeItem(DISMISSED_AT_KEY);
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

  if (bannerState === 'sent') {
    return (
      <Notice
        tone="success"
        icon={<CheckCircle size={18} />}
        title="Verification email sent!"
        description="Check your inbox for the link."
        onDismiss={handleDismiss}
        dismissLabel="Dismiss verification banner"
      />
    );
  }

  const isResending = bannerState === 'resending';
  const isCoolingDown = cooldownRemaining > 0;

  return (
    <Notice
      tone={errorMessage ? 'danger' : 'brand'}
      role={errorMessage ? 'alert' : 'status'}
      icon={<Mail size={18} />}
      title="Verify your email"
      description={errorMessage ?? 'Check your inbox for the verification link.'}
      action={{
        label: isCoolingDown
          ? `Resend (${formatCooldown(cooldownRemaining)})`
          : isResending
            ? 'Sending...'
            : 'Resend',
        icon: <RefreshCw size={13} className={isResending ? 'animate-spin' : undefined} />,
        onClick: handleResend,
        disabled: isResending || isCoolingDown,
      }}
      onDismiss={handleDismiss}
      dismissLabel="Dismiss verification banner"
    />
  );
};
