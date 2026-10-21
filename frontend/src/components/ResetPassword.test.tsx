import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '../services/api';
import { deferred, renderWithHistory } from '../test/fixtures/shell';
import { ResetPassword } from './ResetPassword';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

const renderPage = (url = '/reset-password?token=reset-token') =>
  renderWithHistory(<ResetPassword />, { entries: [url] });

const location = () => screen.getByTestId('location');
const newPassword = () => screen.getByLabelText('New password');
const confirmPassword = () => screen.getByLabelText('Confirm password');
const submitButton = (name = 'Reset password') => screen.getByRole('button', { name });

type User = ReturnType<typeof renderPage>['user'];

/** Waits for the link check, then fills both password fields. */
const fillPasswords = async (user: User, first: string, second = first) => {
  await screen.findByRole('heading', { name: 'Set a new password' });
  await user.type(newPassword(), first);
  await user.type(confirmPassword(), second);
};

describe('ResetPassword', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ success: true, valid: true });
  });

  describe('link validation', () => {
    it('treats a link without a token as expired', () => {
      renderPage('/reset-password');

      expect(screen.getByRole('heading', { name: 'This link has expired' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
        'href',
        '/forgot-password'
      );
      expect(screen.getByRole('link', { name: 'Back to log in' })).toHaveAttribute(
        'href',
        '/login'
      );
      expect(get).not.toHaveBeenCalled();
    });

    it('checks the link before showing the form', async () => {
      const request = deferred<unknown>();
      get.mockReturnValue(request.promise);
      // "%2B", "%2F" and "%3D" decode to "+", "/" and "="
      renderPage('/reset-password?token=a%2Bb%2Fc%3D');

      expect(screen.getByRole('heading', { name: 'Checking your link…' })).toBeInTheDocument();
      expect(get).toHaveBeenCalledWith('/auth/reset-password/validate?token=a%2Bb%2Fc%3D');

      await act(async () => request.resolve({ success: true, valid: true }));

      expect(screen.getByRole('heading', { name: 'Set a new password' })).toBeInTheDocument();
      expect(newPassword()).toHaveAttribute('autocomplete', 'new-password');
      expect(screen.getByRole('link', { name: 'Back to log in' })).toBeInTheDocument();
    });

    it('shows the expired state for an invalid or used link', async () => {
      get.mockResolvedValue({ success: true, valid: false });

      renderPage();

      expect(
        await screen.findByRole('heading', { name: 'This link has expired' })
      ).toBeInTheDocument();
    });

    it('shows the expired state when the link cannot be checked', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = new ApiError('Not found', 404);
      get.mockRejectedValue(error);

      renderPage();

      expect(
        await screen.findByRole('heading', { name: 'This link has expired' })
      ).toBeInTheDocument();
      expect(warn).toHaveBeenCalledWith(
        '[ResetPassword] Token validation failed; showing expired-link state',
        error
      );
    });
  });

  describe('choosing a new password', () => {
    it('flags the confirmation until it matches', async () => {
      const { user } = renderPage();
      await fillPasswords(user, 'password123', 'password12');

      expect(confirmPassword()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('alert')).toHaveTextContent("Passwords don't match yet");

      await user.type(confirmPassword(), '3');

      expect(confirmPassword()).not.toHaveAttribute('aria-invalid');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('refuses to submit mismatched passwords', async () => {
      const { user } = renderPage();
      await fillPasswords(user, 'password123', 'password456');

      await user.click(submitButton());

      expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
    });

    it('refuses passwords shorter than 8 characters', async () => {
      const { user } = renderPage();
      await fillPasswords(user, 'short');

      // Bypass the native minLength check to reach the form's own validation
      fireEvent.submit(submitButton().closest('form')!);

      expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
    });

    // Regression: the check counted UTF-16 units, so 4–7 emoji passed it and the server refused them
    it('refuses a password of 7 emoji with the length message', async () => {
      const { user } = renderPage();
      await fillPasswords(user, '🌱'.repeat(7));

      await user.click(submitButton());

      expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
    });

    it('accepts a password of 8 emoji, which the server counts as 8 characters', async () => {
      post.mockResolvedValue({ success: true });
      const { user } = renderPage();
      await fillPasswords(user, '🌱'.repeat(8));

      await user.click(submitButton());

      expect(post).toHaveBeenCalledWith('/auth/reset-password', {
        token: 'reset-token',
        new_password: '🌱'.repeat(8),
        confirm_password: '🌱'.repeat(8),
      });
      expect(screen.getByRole('heading', { name: 'Password updated!' })).toBeInTheDocument();
    });

    it('saves the new password and offers to log in', async () => {
      post.mockResolvedValue({ success: true });
      const { user } = renderPage();
      await fillPasswords(user, 'password123');

      await user.click(submitButton());

      expect(post).toHaveBeenCalledWith('/auth/reset-password', {
        token: 'reset-token',
        new_password: 'password123',
        confirm_password: 'password123',
      });
      expect(screen.getByRole('heading', { name: 'Password updated!' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Go to log in' }));
      expect(location()).toHaveTextContent('/login');
    });

    it('submits with Enter', async () => {
      post.mockResolvedValue({ success: true });
      const { user } = renderPage();
      await fillPasswords(user, 'password123');

      await user.type(confirmPassword(), '{Enter}');

      expect(post).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('heading', { name: 'Password updated!' })).toBeInTheDocument();
    });

    it('shows progress and ignores repeated submits', async () => {
      const request = deferred<unknown>();
      post.mockReturnValue(request.promise);
      const { user } = renderPage();
      await fillPasswords(user, 'password123');

      await user.click(submitButton());

      const busy = submitButton('Saving…');
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute('aria-busy', 'true');
      fireEvent.submit(busy.closest('form')!);
      expect(post).toHaveBeenCalledTimes(1);

      await act(async () => request.resolve({ success: true }));
      expect(screen.getByRole('heading', { name: 'Password updated!' })).toBeInTheDocument();
    });

    it.each([
      [
        'the server refuses with a reason',
        { success: false, error: 'Link already used' },
        'Link already used',
      ],
      ['the server refuses without a reason', { success: false }, 'Failed to reset password'],
    ])('explains the failure when %s', async (_label, response, message) => {
      post.mockResolvedValue(response);
      const { user } = renderPage();
      await fillPasswords(user, 'password123');

      await user.click(submitButton());

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(submitButton()).toBeEnabled();
    });

    it.each([
      ['an API error', new ApiError('Link expired', 400), 'Link expired'],
      ['a network error', new Error('Failed to fetch'), 'An error occurred. Please try again.'],
    ])('explains the failure for %s', async (_label, error, message) => {
      post.mockRejectedValue(error);
      const { user } = renderPage();
      await fillPasswords(user, 'password123');

      await user.click(submitButton());

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
    });

    it('lets the error message time out', async () => {
      vi.useFakeTimers();
      renderPage();
      await act(async () => {});

      fireEvent.change(newPassword(), { target: { value: 'password123' } });
      fireEvent.change(confirmPassword(), { target: { value: 'password456' } });
      fireEvent.submit(submitButton().closest('form')!);
      expect(screen.getByText('Passwords do not match')).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(3000));
      expect(screen.queryByText('Passwords do not match')).not.toBeInTheDocument();
    });
  });
});
