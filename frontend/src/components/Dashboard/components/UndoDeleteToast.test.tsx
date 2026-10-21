import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { UNDO_TIMEOUT_DURATION } from '../Dashboard.constants';
import { UndoDeleteToast } from './UndoDeleteToast';

function renderToast() {
  const onUndo = vi.fn();
  const onDismiss = vi.fn();
  const view = render(<UndoDeleteToast tileName="Guitar" onUndo={onUndo} onDismiss={onDismiss} />);
  return { user: userEvent.setup(), onUndo, onDismiss, ...view };
}

describe('UndoDeleteToast', () => {
  it('politely announces which tile was deleted', () => {
    renderToast();

    const toast = screen.getByRole('status');
    expect(toast).toHaveAttribute('aria-live', 'polite');
    expect(toast).toHaveTextContent('Deleted Guitar');
  });

  it('shows a countdown as long as the undo window', () => {
    const { container } = renderToast();

    expect(container.querySelector('[aria-hidden="true"]')).toHaveStyle({
      animationDuration: `${UNDO_TIMEOUT_DURATION}ms`,
    });
  });

  it('undoes the delete', async () => {
    const { user, onUndo, onDismiss } = renderToast();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('can be dismissed', async () => {
    const { user, onUndo, onDismiss } = renderToast();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });
});
