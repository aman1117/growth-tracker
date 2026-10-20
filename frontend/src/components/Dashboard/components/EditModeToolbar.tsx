/**
 * EditModeToolbar Component
 *
 * Sticky controls while customizing tiles: manage hidden tiles, cancel, done,
 * plus a one-line gesture hint.
 */

import { Check, EyeOff, GripVertical, MoveHorizontal, Settings2, X } from 'lucide-react';
import React from 'react';

import styles from './EditModeToolbar.module.css';

interface EditModeToolbarProps {
  hiddenTilesCount: number;
  onManageTiles: () => void;
  onCancel: () => void;
  onSave: () => void;
}

export const EditModeToolbar: React.FC<EditModeToolbarProps> = ({
  hiddenTilesCount,
  onManageTiles,
  onCancel,
  onSave,
}) => {
  const hasHidden = hiddenTilesCount > 0;

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Customize tiles">
      <div className={styles.actions}>
        <button
          type="button"
          onClick={onManageTiles}
          className={`${styles.manageButton} ${hasHidden ? styles.manageHasHidden : ''}`}
          aria-label={hasHidden ? `Manage tiles, ${hiddenTilesCount} hidden` : 'Manage tiles'}
        >
          {hasHidden ? (
            <EyeOff size={16} strokeWidth={2.25} aria-hidden="true" />
          ) : (
            <Settings2 size={16} strokeWidth={2.25} aria-hidden="true" />
          )}
          <span>{hasHidden ? `${hiddenTilesCount} hidden` : 'Manage tiles'}</span>
        </button>

        <div className={styles.primaryActions}>
          <button type="button" onClick={onCancel} className={styles.cancelButton}>
            Cancel
          </button>
          <button type="button" onClick={onSave} className={styles.doneButton}>
            <Check size={16} strokeWidth={3} aria-hidden="true" />
            Done
          </button>
        </div>
      </div>

      <p className={styles.hints}>
        <span className={styles.hint}>
          <GripVertical size={13} strokeWidth={2.5} aria-hidden="true" />
          Drag to move
        </span>
        <span className={styles.hint}>
          <MoveHorizontal size={13} strokeWidth={2.5} aria-hidden="true" />
          Tap to resize
        </span>
        <span className={styles.hint}>
          <X size={13} strokeWidth={3} aria-hidden="true" />
          Hide
        </span>
      </p>
    </div>
  );
};
