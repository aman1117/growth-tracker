import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LogoutDialog } from './LogoutDialog';

function renderDialog(isOpen = true) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  render(<LogoutDialog isOpen={isOpen} onClose={onClose} onConfirm={onConfirm} />);
  return { user: userEvent.setup(), onClose, onConfirm };
}

describe('LogoutDialog', () => {
  beforeEach(() => {
    // Overlays log overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('renders nothing while closed', () => {
    renderDialog(false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks for confirmation and starts on Cancel so Enter cannot log out by accident', () => {
    renderDialog();

    const dialog = screen.getByRole('alertdialog', { name: 'Log out?' });
    expect(dialog).toHaveAccessibleDescription(
      "You'll need to sign in again to keep tracking on this device."
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('logs out only after confirming', async () => {
    const { user, onConfirm, onClose } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Log out' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    [
      'Cancel',
      (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: 'Cancel' })),
    ],
    ['Escape', (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
  ])('stays signed in after %s', async (_label, dismiss) => {
    const { user, onConfirm, onClose } = renderDialog();

    await dismiss(user);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
