import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../services/api';
import { deferred } from '../../../test/fixtures/settings';
import { PasswordDialog } from './PasswordDialog';

const { post } = vi.hoisted(() => ({
  post: vi.fn<(endpoint: string, body?: unknown) => Promise<unknown>>(),
}));

vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  api: { post },
}));

type Props = ComponentProps<typeof PasswordDialog>;

const GENERIC_ERROR = "Couldn't change your password. Try again.";

function renderDialog(props: Partial<Props> = {}) {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const element = (overrides: Partial<Props> = {}) => (
    <PasswordDialog isOpen onClose={onClose} onSuccess={onSuccess} {...props} {...overrides} />
  );
  const view = render(element());
  const current = () => screen.getByLabelText('Current password');
  const next = () => screen.getByLabelText('New password');
  const fill = async (currentValue: string, nextValue: string) => {
    if (currentValue) await user.type(current(), currentValue);
    if (nextValue) await user.type(next(), nextValue);
    await user.click(screen.getByRole('button', { name: 'Update' }));
  };
  return {
    user,
    onClose,
    onSuccess,
    current,
    next,
    fill,
    rerenderWith: (overrides: Partial<Props>) => view.rerender(element(overrides)),
  };
}

describe('PasswordDialog', () => {
  beforeEach(() => {
    post.mockReset();
    // Modal logs overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('renders nothing while closed', () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks for the current and a new password', () => {
    const { current, next } = renderDialog();

    expect(screen.getByRole('dialog', { name: 'Change password' })).toBeInTheDocument();
    expect(current()).toHaveFocus();
    expect(current()).toHaveAttribute('autocomplete', 'current-password');
    expect(next()).toHaveAttribute('autocomplete', 'new-password');
    expect(next()).toHaveAccessibleDescription('At least 8 characters');
  });

  it('requires both fields', async () => {
    const { fill, current, next } = renderDialog();

    await fill('', '');

    expect(current()).toHaveAccessibleDescription('Enter your current password');
    expect(next()).toHaveAccessibleDescription('Choose a new password');
    expect(current()).toHaveAttribute('aria-invalid', 'true');
    expect(next()).toHaveAttribute('aria-invalid', 'true');
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['is too short', 'short', 'Password must be at least 8 characters'],
    ['is only spaces', ' '.repeat(10), 'Password must be at least 8 characters'],
    ['is 7 emoji (14 UTF-16 units)', '🔥'.repeat(7), 'Password must be at least 8 characters'],
    ['is 7 emoji once trimmed', `  ${'🔥'.repeat(7)}  `, 'Password must be at least 8 characters'],
    ['matches the current one', 'oldpass123', 'Pick a password different from your current one'],
  ])('rejects a new password that %s', async (_label, newPassword, message) => {
    const { fill, current, next } = renderDialog();

    await fill('oldpass123', newPassword);

    expect(next()).toHaveAccessibleDescription(message);
    expect(current()).not.toHaveAttribute('aria-invalid');
    expect(post).not.toHaveBeenCalled();
  });

  it('changes the password and closes', async () => {
    post.mockResolvedValue({ success: true });
    const { fill, onSuccess, onClose } = renderDialog();

    await fill('oldpass123', 'newpass456');

    expect(post).toHaveBeenCalledWith('/change-password', {
      current_password: 'oldpass123',
      new_password: 'newpass456',
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('accepts a new password of 8 emoji, which the server counts as 8 characters', async () => {
    post.mockResolvedValue({ success: true });
    const { fill, next, onSuccess } = renderDialog();

    await fill('oldpass123', '🔥'.repeat(8));

    expect(next()).not.toHaveAttribute('aria-invalid');
    expect(post).toHaveBeenCalledWith('/change-password', {
      current_password: 'oldpass123',
      new_password: '🔥'.repeat(8),
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('puts a wrong current password on that field', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    post.mockRejectedValue(new ApiError('Current password is incorrect', 400, 'INVALID_PASSWORD'));
    const { fill, current, next, onSuccess } = renderDialog();

    await fill('wrongpass1', 'newpass456');

    await waitFor(() =>
      expect(current()).toHaveAccessibleDescription('Current password is incorrect')
    );
    expect(current()).toHaveAttribute('aria-invalid', 'true');
    expect(next()).not.toHaveAttribute('aria-invalid');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[Settings] Password change failed', {
      code: 'INVALID_PASSWORD',
    });
  });

  it.each([
    [
      'a rejected request',
      new ApiError('Too many attempts', 429, 'RATE_LIMITED'),
      'Too many attempts',
    ],
    ['a server error', new ApiError('Internal server error', 500), GENERIC_ERROR],
    ['a network failure', new TypeError('Failed to fetch'), GENERIC_ERROR],
  ])('shows %s above the form', async (_label, error, message) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    post.mockRejectedValue(error);
    const { fill, current } = renderDialog();

    await fill('oldpass123', 'newpass456');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(current()).not.toHaveAttribute('aria-invalid');
  });

  it.each([
    [{ success: false, error: 'Password is too common' }, 'Password is too common'],
    [{ success: false }, GENERIC_ERROR],
  ])('shows why an unsuccessful response was rejected', async (response, message) => {
    post.mockResolvedValue(response);
    const { fill, onSuccess } = renderDialog();

    await fill('oldpass123', 'newpass456');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('clears an error when its field is edited', async () => {
    const { user, fill, current, next } = renderDialog();
    await fill('', '');

    await user.type(current(), 'o');
    expect(current()).not.toHaveAttribute('aria-invalid');
    expect(next()).toHaveAttribute('aria-invalid', 'true');

    await user.type(next(), 'n');
    expect(next()).not.toHaveAttribute('aria-invalid');
  });

  it('clears the form error when either field is edited', async () => {
    post.mockResolvedValue({ success: false, error: 'Password is too common' });
    const { user, fill, next } = renderDialog();
    await fill('oldpass123', 'newpass456');
    await screen.findByRole('alert');

    await user.type(next(), '7');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows progress and ignores repeat submits while updating', async () => {
    const request = deferred<unknown>();
    post.mockReturnValue(request.promise);
    const { fill, current, onSuccess } = renderDialog();

    await fill('oldpass123', 'newpass456');

    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
    fireEvent.submit(current().closest('form')!);
    expect(post).toHaveBeenCalledTimes(1);

    request.resolve({ success: true });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('never keeps passwords between openings', async () => {
    const { user, current, next, rerenderWith } = renderDialog();
    await user.type(current(), 'oldpass123');
    await user.type(next(), 'newpass456');

    rerenderWith({ isOpen: false });
    rerenderWith({ isOpen: true });

    expect(current()).toHaveValue('');
    expect(next()).toHaveValue('');
  });

  it('cancels without a request', async () => {
    const { user, current, onClose } = renderDialog();

    await user.type(current(), 'oldpass123');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
});
