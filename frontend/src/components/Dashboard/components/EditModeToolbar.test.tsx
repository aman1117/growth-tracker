import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EditModeToolbar } from './EditModeToolbar';

function renderToolbar(hiddenTilesCount = 0) {
  const handlers = { onManageTiles: vi.fn(), onCancel: vi.fn(), onSave: vi.fn() };
  render(<EditModeToolbar hiddenTilesCount={hiddenTilesCount} {...handlers} />);
  return { user: userEvent.setup(), ...handlers };
}

describe('EditModeToolbar', () => {
  it('is a labelled toolbar with gesture hints', () => {
    renderToolbar();

    const toolbar = screen.getByRole('toolbar', { name: 'Customize tiles' });
    expect(toolbar).toHaveTextContent('Drag to move');
    expect(toolbar).toHaveTextContent('Tap to resize');
    expect(toolbar).toHaveTextContent('Hide');
  });

  it('offers "Manage tiles" when nothing is hidden', async () => {
    const { user, onManageTiles } = renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Manage tiles' }));

    expect(onManageTiles).toHaveBeenCalledTimes(1);
  });

  it('announces how many tiles are hidden', async () => {
    const { user, onManageTiles } = renderToolbar(3);

    const manage = screen.getByRole('button', { name: 'Manage tiles, 3 hidden' });
    expect(manage).toHaveTextContent('3 hidden');

    await user.click(manage);
    expect(onManageTiles).toHaveBeenCalledTimes(1);
  });

  it('cancels or saves the edits', async () => {
    const { user, onCancel, onSave } = renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
