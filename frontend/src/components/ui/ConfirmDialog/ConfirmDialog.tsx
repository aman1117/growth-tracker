/**
 * ConfirmDialog Component
 *
 * Centered confirmation dialog for short yes/no decisions (hide a tile,
 * log out, delete...). Handles Escape, the system Back gesture, scroll lock,
 * initial focus (Cancel for destructive actions) and focus restoration.
 *
 * @example
 * <ConfirmDialog
 *   title="Hide tile?"
 *   description="You can restore it anytime."
 *   icon={<EyeOff />}
 *   tone="warning"
 *   confirmLabel="Hide"
 *   onConfirm={hide}
 *   onCancel={close}
 * />
 */

import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useBackDismiss } from '../../../hooks/useBackDismiss';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useEscapeKey } from '../../../hooks/useEscapeKey';
import styles from './ConfirmDialog.module.css';

export type ConfirmDialogTone = 'brand' | 'warning' | 'danger';

export interface ConfirmDialogProps {
  /** Whether the dialog is shown (defaults to true for conditional mounting) */
  isOpen?: boolean;
  /** Short question, e.g. "Log out?" */
  title: string;
  /** Supporting copy */
  description?: ReactNode;
  /** Icon shown in the tinted chip */
  icon?: ReactNode;
  /** Colors the icon chip; `danger` also makes the confirm button red */
  tone?: ConfirmDialogTone;
  /** Confirm button text */
  confirmLabel?: string;
  /** Cancel button text */
  cancelLabel?: string;
  /** Shows a spinner and disables both actions */
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen = true,
  title,
  description,
  icon,
  tone = 'brand',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  loading = false,
  onConfirm,
  onCancel,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isDanger = tone === 'danger';

  // System Back gesture / button cancels instead of leaving the page
  useBackDismiss(isOpen, onCancel);
  // Escape only reaches the top-most overlay, so a parent panel stays open. While busy the
  // dialog keeps that slot and ignores Escape, so the key can't fall through to the panel.
  useEscapeKey(isOpen, () => {
    if (!loading) onCancel();
  });
  useBodyScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Destructive actions start on Cancel so a stray Enter can't confirm them
    (isDanger ? cancelRef : confirmRef).current?.focus();

    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [isOpen, isDanger]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        {icon && (
          <span className={`${styles.icon} ${styles[tone]}`} aria-hidden="true">
            {icon}
          </span>
        )}
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {description && (
          <div id={descriptionId} className={styles.description}>
            {description}
          </div>
        )}

        <div className={styles.actions}>
          <button
            ref={cancelRef}
            type="button"
            className={`btn btn-outline ${styles.action}`}
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${isDanger ? styles.dangerButton : 'btn-primary'} ${styles.action}`}
            onClick={onConfirm}
            disabled={loading}
            aria-busy={loading}
          >
            {loading && <Loader2 size={16} className={styles.spinner} aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ConfirmDialog;
