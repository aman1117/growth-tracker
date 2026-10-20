/**
 * Profile Picture Dialog
 *
 * Action sheet for uploading, replacing or removing the profile picture.
 */

import { Camera, ImagePlus, Trash2 } from 'lucide-react';
import React from 'react';

import { VALIDATION } from '../../../constants/validation';
import { Modal } from '../../ui';
import type { ProfilePictureDialogProps } from '../SettingsPage.types';
import styles from './SettingsDialogs.module.css';

const MAX_MB = VALIDATION.MAX_FILE_SIZE / (1024 * 1024);

export const ProfilePictureDialog: React.FC<ProfilePictureDialogProps> = ({
  isOpen,
  onClose,
  hasProfilePic,
  onUploadClick,
  onRemoveClick,
}) => (
  <Modal
    isOpen={isOpen}
    onClose={onClose}
    title="Profile photo"
    subtitle="Show people who's behind the streak"
    icon={
      <span className={`${styles.toneIcon} ${styles.toneSky}`}>
        <Camera size={20} strokeWidth={2.3} />
      </span>
    }
    maxWidth="400px"
  >
    <div className={styles.actions}>
      <button
        type="button"
        className={styles.action}
        onClick={() => {
          // Must run inside the tap so the browser allows opening the file picker
          onUploadClick();
          onClose();
        }}
      >
        <span className={styles.actionIcon} aria-hidden="true">
          <ImagePlus size={20} strokeWidth={2.25} />
        </span>
        <span className={styles.actionText}>
          <span className={styles.actionTitle}>
            {hasProfilePic ? 'Choose a new photo' : 'Upload a photo'}
          </span>
          <span className={styles.actionHint}>JPG, PNG, WebP or HEIC · up to {MAX_MB} MB</span>
        </span>
      </button>

      {hasProfilePic && (
        <button
          type="button"
          className={`${styles.action} ${styles.actionDanger}`}
          onClick={onRemoveClick}
        >
          <span className={styles.actionIcon} aria-hidden="true">
            <Trash2 size={20} strokeWidth={2.25} />
          </span>
          <span className={styles.actionText}>
            <span className={styles.actionTitle}>Remove photo</span>
            <span className={styles.actionHint}>Your initial will show instead</span>
          </span>
        </button>
      )}
    </div>
  </Modal>
);
