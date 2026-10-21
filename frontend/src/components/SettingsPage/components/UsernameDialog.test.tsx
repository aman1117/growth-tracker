import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../services/api';
import { deferred } from '../../../test/fixtures/settings';
import { UsernameDialog } from './UsernameDialog';

const { post } = vi.hoisted(() => ({
  post: vi.fn<(endpoint: string, body?: unknown) => Promise<unknown>>(),
}));

vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  api: { post },
}));

type Props = ComponentProps<typeof UsernameDialog>;

function renderDialog(props: Partial<Props> = {}) {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const element = (overrides: Partial<Props> = {}) => (
    <UsernameDialog
      isOpen
      onClose={onClose}
      currentUsername="alice"
      onSuccess={onSuccess}
      {...props}
      {...overrides}
    />
  );
  const view = render(element());
  return {
    user,
    onClose,
    onSuccess,
    rerenderWith: (overrides: Partial<Props>) => view.rerender(element(overrides)),
    input: () => screen.getByRole('textbox', { name: 'Username' }),
  };
}

async function submitUsername(user: ReturnType<typeof userEvent.setup>, value: string) {
  const input = screen.getByRole('textbox', { name: 'Username' });
  await user.clear(input);
  await user.type(input, value);
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

describe('UsernameDialog', () => {
  beforeEach(() => {
    post.mockReset();
    // Modal logs overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('renders nothing while closed', () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on the current username with the rules as a hint', () => {
    const { input } = renderDialog();

    expect(screen.getByRole('dialog', { name: 'Change username' })).toBeInTheDocument();
    expect(input()).toHaveValue('alice');
    expect(input()).toHaveFocus();
    expect(input()).toHaveAccessibleDescription(
      '3–20 characters: lowercase letters, numbers, _ and .'
    );
  });

  it('lowercases what the user types', async () => {
    const { user, input } = renderDialog();

    await user.clear(input());
    await user.type(input(), 'Grow.With_Me');

    expect(input()).toHaveValue('grow.with_me');
  });

  it.each([
    ['too short', 'ab', 'Username must be 3-20 characters'],
    ['too long', 'a'.repeat(21), 'Username must be 3-20 characters'],
    ['short once trimmed', '  ab  ', 'Username must be 3-20 characters'],
    ['two emoji, so 2 characters', '🌱🌱', 'Username must be 3-20 characters'],
    ['a dash', 'new-name', 'Only lowercase letters, numbers, _ and . allowed'],
    ['a space', 'new name', 'Only lowercase letters, numbers, _ and . allowed'],
    [
      '18 characters with emoji',
      'growth_tracker_🌱🌱🌱',
      'Only lowercase letters, numbers, _ and . allowed',
    ],
  ])('rejects a username that is %s without calling the server', async (_label, value, message) => {
    const { user, input } = renderDialog();

    await submitUsername(user, value);

    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(input()).toHaveAccessibleDescription(message);
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['abc', 'a'.repeat(20), 'grow.with_me9'])(
    'accepts %j, which the server allows',
    async (value) => {
      post.mockResolvedValue({ success: true, new_username: value });
      const { user, onSuccess } = renderDialog();

      await submitUsername(user, value);

      expect(post).toHaveBeenCalledWith('/update-username', { new_username: value });
      await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(value));
    }
  );

  it('clears the error as soon as the user edits the field', async () => {
    const { user, input } = renderDialog();

    await submitUsername(user, 'ab');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.type(input(), 'c');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input()).not.toHaveAttribute('aria-invalid');
  });

  it('closes without a request when the username did not change', async () => {
    const { user, onClose, onSuccess } = renderDialog();

    await submitUsername(user, ' alice ');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('saves the new username and closes', async () => {
    post.mockResolvedValue({ success: true, new_username: 'new_alice' });
    const { user, onClose, onSuccess } = renderDialog();

    await submitUsername(user, 'new_alice');

    expect(post).toHaveBeenCalledWith('/update-username', { new_username: 'new_alice' });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('new_alice'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('submits with Enter from the keyboard', async () => {
    post.mockResolvedValue({ success: true, new_username: 'bob' });
    const { user, input, onSuccess } = renderDialog();

    await user.clear(input());
    await user.type(input(), 'bob{Enter}');

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('bob'));
  });

  it('shows progress and ignores repeat submits while saving', async () => {
    const request = deferred<unknown>();
    post.mockReturnValue(request.promise);
    const { user, input, onSuccess } = renderDialog();

    await submitUsername(user, 'new_alice');

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await user.type(input(), '{Enter}');
    expect(post).toHaveBeenCalledTimes(1);

    request.resolve({ success: true, new_username: 'new_alice' });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('new_alice'));
  });

  it('surfaces a taken username from the server and stays open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    post.mockRejectedValue(new ApiError('Username already taken', 409, 'USERNAME_TAKEN'));
    const { user, input, onClose, onSuccess } = renderDialog();

    await submitUsername(user, 'bob');

    expect(await screen.findByRole('alert')).toHaveTextContent('Username already taken');
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[Settings] Username update failed', {
      code: 'USERNAME_TAKEN',
    });
  });

  it.each([
    ['a server error', new ApiError('Internal server error', 500)],
    ['a network failure', new TypeError('Failed to fetch')],
  ])('shows a generic message after %s', async (_label, error) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    post.mockRejectedValue(error);
    const { user } = renderDialog();

    await submitUsername(user, 'bob');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't update your username. Try again."
    );
  });

  it.each([
    [{ success: false, error: 'That username is reserved' }, 'That username is reserved'],
    [{ success: false }, "Couldn't update your username. Try again."],
  ])('shows why an unsuccessful response was rejected', async (response, message) => {
    post.mockResolvedValue(response);
    const { user, onSuccess } = renderDialog();

    await submitUsername(user, 'bob');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('starts from a fresh form every time it opens', async () => {
    const { user, input, rerenderWith } = renderDialog();
    await submitUsername(user, 'ab');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerenderWith({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerenderWith({ isOpen: true, currentUsername: 'alice2' });

    expect(input()).toHaveValue('alice2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    [
      'Cancel',
      (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: 'Cancel' })),
    ],
    [
      'the close button',
      (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: 'Close' })),
    ],
    ['Escape', (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
  ])('closes with %s without saving', async (_label, close) => {
    const { user, onClose } = renderDialog();

    await close(user);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
});
