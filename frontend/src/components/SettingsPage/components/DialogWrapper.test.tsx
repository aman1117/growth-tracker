import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DialogWrapper } from './DialogWrapper';

describe('DialogWrapper (deprecated)', () => {
  beforeEach(() => {
    // Modal logs overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  function renderWrapper() {
    const onClose = vi.fn();
    render(
      <DialogWrapper onClose={onClose}>
        <p>Legacy content</p>
      </DialogWrapper>
    );
    return { user: userEvent.setup(), onClose };
  }

  it('shows its children in an open dialog without a header', () => {
    renderWrapper();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Legacy content');
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('closes with Escape', async () => {
    const { user, onClose } = renderWrapper();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked, not the content', async () => {
    const { user, onClose } = renderWrapper();

    await user.click(screen.getByText('Legacy content'));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
