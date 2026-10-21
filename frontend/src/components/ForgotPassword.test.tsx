import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '../services/api';
import { deferred, renderWithHistory } from '../test/fixtures/shell';
import { ForgotPassword } from './ForgotPassword';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const post = vi.mocked(api.post);

const renderPage = () => renderWithHistory(<ForgotPassword />, { entries: ['/forgot-password'] });
const emailField = () => screen.getByLabelText('Email address');

describe('ForgotPassword', () => {
  beforeEach(() => {
    post.mockReset();
  });

  it('asks for the account email', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
    expect(emailField()).toHaveAttribute('type', 'email');
    expect(emailField()).toBeRequired();
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Back to log in' })).toHaveAttribute('href', '/login');
  });

  it('sends the reset link and asks the user to check their inbox', async () => {
    post.mockResolvedValue({ success: true });
    const { user } = renderPage();

    await user.type(emailField(), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(post).toHaveBeenCalledWith('/auth/forgot-password', { email: 'alice@example.com' });
    expect(screen.getByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText(/It expires in 15 minutes\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to log in' })).toHaveAttribute('href', '/login');
  });

  it('shows the same confirmation for an address without an account, so accounts stay private', async () => {
    // The server answers unknown addresses exactly like registered ones
    post.mockResolvedValue({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    });
    const { user } = renderPage();

    await user.type(emailField(), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(screen.getByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(screen.getByText('nobody@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // Regression: a failed request used to show "Check your inbox" although no link was sent.
  it.each([
    [
      new ApiError('Too many password reset requests. Please try again later.', 429),
      'Too many password reset requests. Please try again later.',
    ],
    [new TypeError('Failed to fetch'), 'An error occurred. Please try again.'],
  ])('reports a failed request (%s) instead of confirming', async (error, message) => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    post.mockRejectedValue(error);
    const { user } = renderPage();

    await user.type(emailField(), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Check your inbox' })).not.toBeInTheDocument();
    expect(emailField()).toHaveValue('alice@example.com');
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeEnabled();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[ForgotPassword] Reset link request failed; asking the user to retry',
      error
    );
  });

  it('lets the user retry after a failure without the old error coming back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    post
      .mockRejectedValueOnce(new ApiError('Request failed', 503))
      .mockResolvedValueOnce({ success: true });
    const { user } = renderPage();
    await user.type(emailField(), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed');

    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(post).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(screen.getByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lets the error message time out', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    post.mockRejectedValue(new TypeError('Failed to fetch'));
    renderPage();

    fireEvent.change(emailField(), { target: { value: 'alice@example.com' } });
    fireEvent.submit(emailField().closest('form')!);
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('An error occurred. Please try again.');

    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('submits with Enter', async () => {
    post.mockResolvedValue({ success: true });
    const { user } = renderPage();

    await user.type(emailField(), 'alice@example.com{Enter}');

    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
  });

  it('shows progress and ignores repeated submits', async () => {
    const request = deferred<unknown>();
    post.mockReturnValue(request.promise);
    const { user } = renderPage();

    await user.type(emailField(), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    const busy = screen.getByRole('button', { name: 'Sending…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');

    fireEvent.submit(busy.closest('form')!);
    expect(post).toHaveBeenCalledTimes(1);

    await act(async () => request.resolve({ success: true }));
    expect(screen.getByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
  });

  it('lets the user correct the address', async () => {
    post.mockResolvedValue({ success: true });
    const { user } = renderPage();
    await user.type(emailField(), 'alice@exmaple.com{Enter}');

    await user.click(screen.getByRole('button', { name: 'Use a different email' }));

    expect(screen.getByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
    expect(emailField()).toHaveValue('alice@exmaple.com');
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeEnabled();
  });
});
