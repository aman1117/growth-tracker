import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Modal, type ModalProps } from './Modal';
import styles from './Modal.module.css';

function renderModal(props: Partial<ModalProps> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <Modal isOpen onClose={onClose} title="Edit profile" {...props}>
      {props.children ?? <p>Body</p>}
    </Modal>
  );
  return { onClose, ...utils };
}

/** A page with a trigger button that opens the modal, like real callers. */
function ModalTrigger() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="Settings">
        <p>Settings body</p>
      </Modal>
    </>
  );
}

/** A modal that opens a second modal on top of itself. */
function NestedModals({
  onOuterClose,
  onInnerClose,
}: {
  onOuterClose: () => void;
  onInnerClose: () => void;
}) {
  const [outerOpen, setOuterOpen] = useState(true);
  const [innerOpen, setInnerOpen] = useState(false);
  return (
    <Modal
      isOpen={outerOpen}
      onClose={() => {
        onOuterClose();
        setOuterOpen(false);
      }}
      title="Account"
    >
      <button type="button" onClick={() => setInnerOpen(true)}>
        Delete account
      </button>
      <Modal
        isOpen={innerOpen}
        onClose={() => {
          onInnerClose();
          setInnerOpen(false);
        }}
        title="Are you sure?"
      >
        This cannot be undone.
      </Modal>
    </Modal>
  );
}

describe('Modal', () => {
  it('renders nothing while closed', () => {
    renderModal({ isOpen: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('renders a labelled modal dialog in a portal on document.body', () => {
    const { container } = renderModal({
      subtitle: 'Visible to everyone',
      footer: <button type="button">Save</button>,
    });
    const dialog = screen.getByRole('dialog', { name: 'Edit profile' });

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(container).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
    expect(within(dialog).getByText('Body').parentElement).toHaveClass(styles.content);
    expect(within(dialog).getByText('Visible to everyone')).toHaveClass(styles.subtitle);
    expect(within(dialog).getByRole('button', { name: 'Save' }).parentElement).toHaveClass(
      styles.footer
    );
  });

  it('shows a decorative header icon', () => {
    renderModal({ icon: <svg data-icon="user" /> });
    const icon = screen.getByRole('dialog').querySelector('[data-icon="user"]');

    expect(icon?.parentElement).toHaveClass(styles.headerIcon);
    expect(icon?.parentElement).toHaveAttribute('aria-hidden', 'true');
  });

  it('omits the header and accessible name without a title, icon or close button', () => {
    renderModal({ title: undefined, showCloseButton: false });
    const dialog = screen.getByRole('dialog');

    expect(dialog).not.toHaveAttribute('aria-labelledby');
    expect(dialog.querySelector(`.${styles.header}`)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('keeps the header for the close button when there is no title', () => {
    renderModal({ title: undefined });

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('closes from the close button', async () => {
    const { onClose } = renderModal();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click but not on clicks inside the dialog', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByText('Body'));
    await user.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    await user.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('can ignore backdrop clicks', async () => {
    const { onClose } = renderModal({ closeOnBackdrop: false });

    await userEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape unless disabled', async () => {
    const user = userEvent.setup();
    const { onClose, rerender } = renderModal();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Modal isOpen onClose={onClose} title="Edit profile" closeOnEscape={false}>
        <p>Body</p>
      </Modal>
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the dialog and returns it to the trigger on close', async () => {
    const user = userEvent.setup();
    render(<ModalTrigger />);
    const trigger = screen.getByRole('button', { name: 'Open settings' });

    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveFocus();

    // The close button is the first stop when tabbing inside the dialog
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps focus on a child that focused itself on mount', () => {
    renderModal({ children: <input aria-label="Display name" autoFocus /> });
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveFocus();
  });

  it('locks body scrolling while open and restores the previous value', () => {
    document.body.style.overflow = 'scroll';
    const onClose = vi.fn();
    const { rerender } = render(
      <Modal isOpen onClose={onClose}>
        Body
      </Modal>
    );
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <Modal isOpen={false} onClose={onClose}>
        Body
      </Modal>
    );
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('lets only the top-most modal handle Escape and keeps scroll locked until the last closes', async () => {
    const user = userEvent.setup();
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();
    render(<NestedModals onOuterClose={onOuterClose} onInnerClose={onInnerClose} />);

    await user.click(screen.getByRole('button', { name: 'Delete account' }));
    expect(screen.getByRole('dialog', { name: 'Are you sure?' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onOuterClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Are you sure?' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Account' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');
    expect(onOuterClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('applies the size preset, custom class and max width', () => {
    renderModal({ size: 'large', className: 'photo-modal', maxWidth: '480px' });
    const dialog = screen.getByRole('dialog');

    expect(dialog).toHaveClass(styles.modal, styles.large, 'photo-modal');
    expect(dialog.style.getPropertyValue('--modal-max-width')).toBe('480px');
  });

  it('defaults to the medium size, without an inline max width, as a phone sheet', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');

    expect(dialog).toHaveClass(styles.medium);
    expect(dialog).not.toHaveAttribute('style');
    expect(dialog.parentElement).not.toHaveClass(styles.dialogOnMobile);
  });

  it('can stay a top-anchored dialog on phones', () => {
    renderModal({ mobileLayout: 'dialog' });
    expect(screen.getByRole('dialog').parentElement).toHaveClass(
      styles.backdrop,
      styles.dialogOnMobile
    );
  });

  it('closes on the system Back action', async () => {
    const { onClose } = renderModal();

    await waitFor(() =>
      expect(window.history.state).toEqual(
        expect.objectContaining({ __overlayId: expect.any(String) })
      )
    );
    act(() => window.history.back());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
