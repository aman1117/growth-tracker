/**
 * UndoDeleteToast Component
 *
 * Toast notification with undo capability for deleted tiles.
 */

import { Trash2, Undo2, X } from 'lucide-react';
import React from 'react';

import { UNDO_TIMEOUT_DURATION } from '../Dashboard.constants';
import styles from './UndoDeleteToast.module.css';

interface UndoDeleteToastProps {
  tileName: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export const UndoDeleteToast: React.FC<UndoDeleteToastProps> = ({
  tileName,
  onUndo,
  onDismiss,
}) => {
  return (
    <div className={styles.wrapper} role="status" aria-live="polite">
      <div className={styles.toast}>
        {/* Countdown until the undo option disappears */}
        <span
          className={styles.progress}
          style={{ animationDuration: `${UNDO_TIMEOUT_DURATION}ms` }}
          aria-hidden="true"
        />

        <span className={styles.icon} aria-hidden="true">
          <Trash2 size={15} strokeWidth={2.25} />
        </span>

        <span className={styles.text}>
          Deleted <strong>{tileName}</strong>
        </span>

        <button type="button" onClick={onUndo} className={styles.undoButton}>
          <Undo2 size={14} strokeWidth={2.5} aria-hidden="true" />
          Undo
        </button>

        <button
          type="button"
          onClick={onDismiss}
          className={styles.dismissButton}
          aria-label="Dismiss"
        >
          <X size={16} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
