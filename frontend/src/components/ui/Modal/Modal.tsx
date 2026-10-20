/**
 * Modal Component
 *
 * Reusable modal dialog with backdrop and animations.
 * Uses React Portal to render at document body level for proper stacking.
 * Glass dialog on larger screens; bottom sheet on phones (unless `mobileLayout="dialog"`).
 */

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useBackDismiss } from '../../../hooks/useBackDismiss';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useEscapeKey } from '../../../hooks/useEscapeKey';
import styles from './Modal.module.css';

export type ModalSize = 'small' | 'medium' | 'large' | 'fullscreen';
export type ModalMobileLayout = 'sheet' | 'dialog';

export interface ModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Modal title */
  title?: string;
  /** Optional icon shown before the title */
  icon?: ReactNode;
  /** Optional supporting line under the title */
  subtitle?: ReactNode;
  /** Modal content */
  children: ReactNode;
  /** Whether to show close button */
  showCloseButton?: boolean;
  /** Close on backdrop click */
  closeOnBackdrop?: boolean;
  /** Close on escape key */
  closeOnEscape?: boolean;
  /** Size preset for modal width */
  size?: ModalSize;
  /** Custom max width (overrides size) */
  maxWidth?: string;
  /**
   * Phone layout: `sheet` (default) slides up from the bottom; `dialog` stays
   * top-anchored so forms that open the on-screen keyboard remain visible.
   */
  mobileLayout?: ModalMobileLayout;
  /** Footer content */
  footer?: ReactNode;
  /** Additional CSS class */
  className?: string;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  icon,
  subtitle,
  children,
  showCloseButton = true,
  closeOnBackdrop = true,
  closeOnEscape = true,
  size = 'medium',
  maxWidth,
  mobileLayout = 'sheet',
  footer,
  className,
}) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeKey(isOpen && closeOnEscape, onClose);
  useBodyScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) return;

    // Move focus into the dialog unless a child (e.g. an autoFocus input) already took it
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
      dialogRef.current.focus({ preventScroll: true });
    }

    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  // System Back gesture / button closes the modal instead of leaving the page
  useBackDismiss(isOpen, onClose);

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && closeOnBackdrop) {
      onClose();
    }
  };

  const hasHeader = !!(title || icon || showCloseButton);

  const modalContent = (
    <div
      className={`${styles.backdrop} ${mobileLayout === 'dialog' ? styles.dialogOnMobile : ''}`}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        className={`${styles.modal} ${styles[size]} ${className || ''}`}
        // maxWidth flows through a CSS variable so phones can still use a full-width sheet
        style={maxWidth ? ({ '--modal-max-width': maxWidth } as React.CSSProperties) : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
      >
        {hasHeader && (
          <div className={styles.header}>
            {icon && (
              <span className={styles.headerIcon} aria-hidden="true">
                {icon}
              </span>
            )}
            <div className={styles.headerText}>
              {title && (
                <h2 id={titleId} className={styles.title}>
                  {title}
                </h2>
              )}
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </div>
            {showCloseButton && (
              <button
                type="button"
                className={styles.closeButton}
                onClick={onClose}
                aria-label="Close"
              >
                <X size={18} strokeWidth={2.25} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <div className={styles.content}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );

  // Use portal to render modal at body level, avoiding stacking context issues
  return createPortal(modalContent, document.body);
};

export default Modal;
