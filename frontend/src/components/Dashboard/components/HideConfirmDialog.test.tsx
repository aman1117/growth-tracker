import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HideConfirmDialog } from './HideConfirmDialog';

// The theme store (reached through the ui barrel) reads matchMedia when its module loads,
// before the shared setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

function renderDialog() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<HideConfirmDialog displayName="Reading" onConfirm={onConfirm} onCancel={onCancel} />);
  return { user: userEvent.setup(), onConfirm, onCancel };
}

describe('HideConfirmDialog', () => {
  beforeEach(() => {
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('asks to confirm hiding the named tile', () => {
    renderDialog();

    const dialog = screen.getByRole('alertdialog', { name: 'Hide this tile?' });
    expect(dialog).toHaveAccessibleDescription(
      'Reading will disappear from your grid. You can bring it back anytime from Manage tiles.'
    );
    // Hiding is reversible, so the safe default action is the confirm button
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveFocus();
  });

  it('hides the tile on confirm', async () => {
    const { user, onConfirm, onCancel } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Hide' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels from the Cancel button or Escape', async () => {
    const { user, onConfirm, onCancel } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
