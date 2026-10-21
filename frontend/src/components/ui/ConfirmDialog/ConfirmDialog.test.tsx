import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Modal } from '../Modal';
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
import styles from './ConfirmDialog.module.css';

function renderDialog(props: Partial<ConfirmDialogProps> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ConfirmDialog title="Log out?" onConfirm={onConfirm} onCancel={onCancel} {...props} />
  );
  return { onConfirm, onCancel, ...utils };
}

/** A trigger that opens the dialog and closes it on either answer. */
function ConfirmTrigger({ tone }: { tone?: ConfirmDialogProps['tone'] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Log out
      </button>
      <ConfirmDialog
        isOpen={open}
        title="Log out?"
        tone={tone}
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/** A panel (Modal) that asks for confirmation on top of itself. */
function PanelWithConfirm({
  loading = false,
  onPanelClose,
  onConfirmCancel,
}: {
  loading?: boolean;
  onPanelClose: () => void;
  onConfirmCancel: () => void;
}) {
  const [panelOpen, setPanelOpen] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <Modal
      isOpen={panelOpen}
      onClose={() => {
        onPanelClose();
        setPanelOpen(false);
      }}
      title="Tiles"
    >
      <button type="button" onClick={() => setConfirmOpen(true)}>
        Hide tile
      </button>
      <ConfirmDialog
        isOpen={confirmOpen}
        title="Hide tile?"
        tone="warning"
        loading={loading}
        onConfirm={vi.fn()}
        onCancel={() => {
          onConfirmCancel();
          setConfirmOpen(false);
        }}
      />
    </Modal>
  );
}

describe('ConfirmDialog', () => {
  it('renders an alertdialog named by its title and described by its description', () => {
    const { container } = renderDialog({ description: 'You will need to sign in again.' });
    const dialog = screen.getByRole('alertdialog', { name: 'Log out?' });

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('You will need to sign in again.');
    expect(screen.getByRole('heading', { level: 2, name: 'Log out?' })).toBeInTheDocument();
    // Rendered through a portal, outside the caller's tree
    expect(container).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
  });

  it('has no description reference without a description', () => {
    renderDialog();
    expect(screen.getByRole('alertdialog')).not.toHaveAttribute('aria-describedby');
  });

  it('renders nothing when closed', () => {
    renderDialog({ isOpen: false });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('uses default action labels and reports each answer', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('supports custom labels and a tinted icon chip', () => {
    renderDialog({
      confirmLabel: 'Hide',
      cancelLabel: 'Keep',
      tone: 'warning',
      icon: <svg data-icon="eye-off" />,
    });
    const dialog = screen.getByRole('alertdialog');
    const chip = dialog.querySelector('[data-icon="eye-off"]')?.parentElement;

    expect(within(dialog).getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Keep' })).toBeInTheDocument();
    expect(chip).toHaveClass(styles.icon, styles.warning);
    expect(chip).toHaveAttribute('aria-hidden', 'true');
  });

  it.each(['brand', 'warning'] as const)('focuses Confirm first for the %s tone', (tone) => {
    renderDialog({ tone });

    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveClass('btn-primary');
  });

  it('focuses Cancel first for destructive actions so a stray Enter cannot confirm', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog({ tone: 'danger', confirmLabel: 'Delete' });
    const confirm = screen.getByRole('button', { name: 'Delete' });

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(confirm).toHaveClass(styles.dangerButton);
    expect(confirm).not.toHaveClass('btn-primary');

    await user.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('can be answered with the keyboard', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the trigger when it closes', async () => {
    const user = userEvent.setup();
    render(<ConfirmTrigger tone="danger" />);
    const trigger = screen.getByRole('button', { name: 'Log out' });

    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('does not try to refocus a trigger that was removed meanwhile', () => {
    const Page = ({ showTrigger, open }: { showTrigger: boolean; open: boolean }) => (
      <>
        {showTrigger && <button type="button">Trigger</button>}
        <ConfirmDialog title="Sure?" isOpen={open} onConfirm={vi.fn()} onCancel={vi.fn()} />
      </>
    );
    const { rerender } = render(<Page showTrigger open={false} />);
    const trigger = screen.getByRole('button', { name: 'Trigger' });
    trigger.focus();

    rerender(<Page showTrigger open />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();

    rerender(<Page showTrigger={false} open />);
    rerender(<Page showTrigger={false} open={false} />);
    expect(trigger).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });

  it('cancels on Escape and on a backdrop click, but not on clicks inside', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog({ description: 'Sure?' });
    const dialog = screen.getByRole('alertdialog');

    await user.click(within(dialog).getByText('Sure?'));
    expect(onCancel).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.click(dialog.parentElement as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('shows a busy confirm button and ignores every way out while loading', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog({ loading: true, confirmLabel: 'Logging out' });
    const dialog = screen.getByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Logging out' });

    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(confirm.querySelector(`.${styles.spinner}`)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await user.keyboard('{Escape}');
    await user.click(dialog.parentElement as HTMLElement);
    await user.click(confirm);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('is not busy by default', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveAttribute('aria-busy', 'false');
  });

  it('handles Escape before the panel underneath, which stays open', async () => {
    const user = userEvent.setup();
    const onPanelClose = vi.fn();
    const onConfirmCancel = vi.fn();
    render(<PanelWithConfirm onPanelClose={onPanelClose} onConfirmCancel={onConfirmCancel} />);

    await user.click(screen.getByRole('button', { name: 'Hide tile' }));
    expect(screen.getByRole('alertdialog', { name: 'Hide tile?' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(onConfirmCancel).toHaveBeenCalledTimes(1);
    expect(onPanelClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Tiles' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');
    expect(onPanelClose).toHaveBeenCalledTimes(1);
    expect(document.body.style.overflow).toBe('');
  });

  it('swallows Escape while busy so it cannot fall through to the panel', async () => {
    const user = userEvent.setup();
    const onPanelClose = vi.fn();
    const onConfirmCancel = vi.fn();
    render(
      <PanelWithConfirm loading onPanelClose={onPanelClose} onConfirmCancel={onConfirmCancel} />
    );

    await user.click(screen.getByRole('button', { name: 'Hide tile' }));
    await user.keyboard('{Escape}');

    expect(onConfirmCancel).not.toHaveBeenCalled();
    expect(onPanelClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Hide tile?' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Tiles' })).toBeInTheDocument();
  });

  it('cancels on the system Back action', async () => {
    const { onCancel } = renderDialog();

    await waitFor(() =>
      expect(window.history.state).toEqual(
        expect.objectContaining({ __overlayId: expect.any(String) })
      )
    );
    act(() => window.history.back());

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });
});
