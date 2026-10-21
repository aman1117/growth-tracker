import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '../services/api';
import { gl } from '../services/goodlogs';
import { useAuthStore } from '../store';
import { deferred, renderWithHistory, signOut } from '../test/fixtures/shell';
import { signIn } from '../test/utils';
import { VerifyEmail } from './VerifyEmail';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const post = vi.mocked(api.post);

const renderPage = (url = '/verify-email?token=verify-token') =>
  renderWithHistory(<VerifyEmail />, { entries: [url] });

const location = () => screen.getByTestId('location');
const failedHeading = () => screen.findByRole('heading', { name: 'Verification failed' });

describe('VerifyEmail', () => {
  const verified = vi.fn();

  beforeEach(() => {
    post.mockReset();
    signOut();
    window.addEventListener('email-verified', verified);
  });

  afterEach(() => {
    window.removeEventListener('email-verified', verified);
  });

  it('explains that the link has no token', async () => {
    renderPage('/verify-email');

    expect(await failedHeading()).toBeInTheDocument();
    expect(screen.getByText('No verification token provided')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
    expect(post).not.toHaveBeenCalled();
  });

  it('verifies the email from the link', async () => {
    signIn({ emailVerified: false });
    const request = deferred<unknown>();
    post.mockReturnValue(request.promise);
    renderPage();

    expect(screen.getByRole('heading', { name: 'Verifying your email…' })).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/auth/verify-email', { token: 'verify-token' });

    await act(async () => request.resolve({ success: true }));

    expect(screen.getByRole('heading', { name: 'Email verified!' })).toBeInTheDocument();
    expect(
      screen.getByText('Thanks for confirming. Your account is fully unlocked.')
    ).toBeInTheDocument();
    expect(gl.track).toHaveBeenCalledWith('email_verified');
    expect(useAuthStore.getState().user?.emailVerified).toBe(true);
    expect(verified).toHaveBeenCalledTimes(1);
  });

  it('reassures users whose email was already verified', async () => {
    post.mockResolvedValue({ success: true, already_verified: true });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Already verified' })).toBeInTheDocument();
    expect(
      screen.getByText('Your email address was already verified. You are all set.')
    ).toBeInTheDocument();
    expect(gl.track).not.toHaveBeenCalledWith('email_verified');
    expect(verified).toHaveBeenCalledTimes(1);
  });

  it('continues to the app', async () => {
    post.mockResolvedValue({ success: true });
    const { user } = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Continue to app' }));

    expect(location()).toHaveTextContent(/^\/$/);
  });

  it.each([
    ['the server gives a reason', { success: false, message: 'Token expired' }, 'Token expired'],
    ['the server gives no reason', { success: false }, 'Verification failed'],
  ])('explains a failed verification when %s', async (_label, response, message) => {
    post.mockResolvedValue(response);
    renderPage();

    expect(await failedHeading()).toBeInTheDocument();
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
    expect(useAuthStore.getState().user).toBeNull();
    expect(verified).not.toHaveBeenCalled();
  });

  it.each([
    ['an API error', new ApiError('Invalid token', 400), 'Invalid token'],
    ['a network error', new Error('Failed to fetch'), 'An error occurred during verification'],
    [
      'an error without a message',
      new ApiError('', 400),
      'This verification link is invalid or has expired.',
    ],
  ])('explains %s', async (_label, error, message) => {
    post.mockRejectedValue(error);
    renderPage();

    expect(await failedHeading()).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  describe('resending the email', () => {
    it('is offered to signed-in users after a failure', async () => {
      signIn({ emailVerified: false });
      post.mockRejectedValueOnce(new ApiError('Token expired', 400));
      const request = deferred<unknown>();
      post.mockReturnValueOnce(request.promise);
      const { user } = renderPage();

      await user.click(await screen.findByRole('button', { name: 'Resend verification email' }));

      expect(post).toHaveBeenLastCalledWith('/auth/resend-verification', {});
      const busy = screen.getByRole('button', { name: 'Sending…' });
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute('aria-busy', 'true');

      await act(async () => request.resolve({ success: true }));

      expect(screen.getByRole('status')).toHaveTextContent(
        'Verification email sent! Check your inbox.'
      );
      expect(gl.track).toHaveBeenCalledWith('email_verification_resent');
      expect(screen.getByRole('button', { name: 'Resend verification email' })).toBeEnabled();
    });

    it.each([
      [
        'an API error',
        new ApiError('Please wait before requesting another email', 429),
        'Please wait before requesting another email',
      ],
      ['a network error', new Error('Failed to fetch'), 'Failed to send email'],
    ])('reports %s', async (_label, error, message) => {
      signIn({ emailVerified: false });
      post.mockRejectedValueOnce(new ApiError('Token expired', 400)).mockRejectedValueOnce(error);
      const { user } = renderPage();

      await user.click(await screen.findByRole('button', { name: 'Resend verification email' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('button', { name: 'Resend verification email' })).toBeEnabled();
    });

    it('is replaced by a login link for signed-out visitors', async () => {
      post.mockRejectedValue(new ApiError('Token expired', 400));
      renderPage();

      await failedHeading();

      expect(
        screen.queryByRole('button', { name: 'Resend verification email' })
      ).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    });
  });

  it('lets the resend confirmation time out', async () => {
    vi.useFakeTimers();
    signIn({ emailVerified: false });
    post.mockRejectedValueOnce(new ApiError('Token expired', 400)).mockResolvedValueOnce({});
    renderPage();
    await act(async () => {});

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    });
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('Verification email sent!');

    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
