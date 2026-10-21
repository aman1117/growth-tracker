import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../services/api';
import { useAuthStore } from '../store';
import { deferred, signOut } from '../test/fixtures/shell';
import { signIn } from '../test/utils';
import { EmailVerificationBanner } from './EmailVerificationBanner';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const post = vi.mocked(api.post);
const DISMISSED_KEY = 'email-verification-dismissed-at';
const NOW = new Date('2024-05-01T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const setup = () => render(<EmailVerificationBanner />);

const resendButton = (name: string | RegExp = 'Resend') => screen.getByRole('button', { name });

// The cooldown runs on fake timers; fireEvent keeps clicks synchronous under them
const click = (element: HTMLElement) => fireEvent.click(element);
const dismissButton = () => screen.getByRole('button', { name: 'Dismiss verification banner' });

/** Lets the resend cooldown tick down second by second. */
const waitSeconds = (seconds: number) => {
  for (let i = 0; i < seconds; i += 1) {
    act(() => vi.advanceTimersByTime(1000));
  }
};

describe('EmailVerificationBanner', () => {
  beforeEach(() => {
    post.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('reminds signed-in users with an unverified email', () => {
    signIn({ emailVerified: false });
    setup();

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Verify your email');
    expect(notice).toHaveTextContent('Check your inbox for the verification link.');
    expect(resendButton()).toBeEnabled();
    expect(dismissButton()).toBeInTheDocument();
  });

  it.each([
    ['signed out', () => signOut()],
    ['verified', () => signIn({ emailVerified: true })],
    ['not known yet', () => signIn()],
  ])('stays hidden when the user is %s', (_label, arrange) => {
    arrange();
    setup();

    expect(screen.queryByText('Verify your email')).not.toBeInTheDocument();
  });

  it('resends the verification email and confirms it was sent', async () => {
    signIn({ emailVerified: false });
    const request = deferred<unknown>();
    post.mockReturnValue(request.promise);
    setup();

    click(resendButton());

    expect(post).toHaveBeenCalledWith('/auth/resend-verification', {});
    expect(resendButton('Sending...')).toBeDisabled();

    await act(async () => request.resolve({ success: true }));

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Verification email sent!');
    expect(notice).toHaveTextContent('Check your inbox for the link.');
    expect(screen.queryByRole('button', { name: /resend/i })).not.toBeInTheDocument();
  });

  it('offers resending again once the two-minute cooldown is over', async () => {
    signIn({ emailVerified: false });
    post.mockResolvedValue({ success: true });
    setup();

    click(resendButton());
    await act(async () => {});
    expect(screen.getByText('Verification email sent!')).toBeInTheDocument();

    waitSeconds(119);
    expect(screen.getByText('Verification email sent!')).toBeInTheDocument();

    waitSeconds(1);
    expect(screen.getByText('Verify your email')).toBeInTheDocument();
    expect(resendButton()).toBeEnabled();
  });

  it('shows a countdown when the server asks to wait', async () => {
    signIn({ emailVerified: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('Please respect the resend cooldown');
    post.mockRejectedValue(error);
    setup();

    click(resendButton());
    await act(async () => {});

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please wait before requesting another email'
    );
    expect(resendButton('Resend (2:00)')).toBeDisabled();
    expect(warn).toHaveBeenCalledWith('[EmailVerificationBanner] Resend failed', error);

    waitSeconds(1);
    expect(resendButton('Resend (1:59)')).toBeDisabled();

    waitSeconds(110);
    expect(resendButton('Resend (0:09)')).toBeDisabled();

    waitSeconds(9);
    expect(resendButton()).toBeEnabled();
  });

  it.each([
    ['a network error', new Error('Network down')],
    ['an unexpected value', 'cooldown'],
  ])('lets the user retry after %s', async (_label, failure) => {
    signIn({ emailVerified: false });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    post.mockRejectedValueOnce(failure).mockResolvedValueOnce({ success: true });
    setup();

    click(resendButton());
    await act(async () => {});

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to send email. Please try again.');
    expect(resendButton()).toBeEnabled();

    click(resendButton());
    await act(async () => {});

    expect(post).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Verification email sent!')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides for a day when dismissed', () => {
    signIn({ emailVerified: false });
    setup();

    click(dismissButton());

    expect(screen.queryByText('Verify your email')).not.toBeInTheDocument();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe(String(NOW.getTime()));
  });

  it('can also dismiss the "sent" confirmation', async () => {
    signIn({ emailVerified: false });
    post.mockResolvedValue({ success: true });
    setup();
    click(resendButton());
    await act(async () => {});

    click(dismissButton());

    expect(screen.queryByText('Verification email sent!')).not.toBeInTheDocument();
  });

  it('stays hidden after a dismissal less than a day ago', () => {
    signIn({ emailVerified: false });
    localStorage.setItem(DISMISSED_KEY, String(NOW.getTime() - DAY_MS + 60_000));

    setup();

    expect(screen.queryByText('Verify your email')).not.toBeInTheDocument();
    expect(localStorage.getItem(DISMISSED_KEY)).not.toBeNull();
  });

  it('comes back a day after being dismissed', () => {
    signIn({ emailVerified: false });
    localStorage.setItem(DISMISSED_KEY, String(NOW.getTime() - DAY_MS));

    setup();

    expect(screen.getByText('Verify your email')).toBeInTheDocument();
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  it('disappears when the email gets verified in another screen', () => {
    signIn({ emailVerified: false });
    setup();

    act(() => {
      window.dispatchEvent(new Event('email-verified'));
    });

    expect(useAuthStore.getState().user?.emailVerified).toBe(true);
    expect(screen.queryByText('Verify your email')).not.toBeInTheDocument();
  });

  it('disappears on logout', () => {
    signIn({ emailVerified: false });
    setup();

    act(() => useAuthStore.getState().logout());

    expect(screen.queryByText('Verify your email')).not.toBeInTheDocument();
  });

  it('stops listening for verification events after unmounting', () => {
    signIn({ emailVerified: false });
    const { unmount } = setup();
    unmount();

    window.dispatchEvent(new Event('email-verified'));

    expect(useAuthStore.getState().user?.emailVerified).toBe(false);
  });
});
