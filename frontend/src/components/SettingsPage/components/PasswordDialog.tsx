/**
 * Password Dialog
 *
 * Dialog for changing password.
 */

import { KeyRound } from 'lucide-react';
import React, { useId, useState } from 'react';

import { VALIDATION, VALIDATION_MESSAGES } from '../../../constants/validation';
import { api, ApiError } from '../../../services/api';
import { characterCount } from '../../../utils/text';
import { Button, Modal, PasswordInput } from '../../ui';
import { getErrorCode, getRequestErrorMessage } from '../settingsForm';
import type { PasswordDialogProps } from '../SettingsPage.types';
import styles from './SettingsDialogs.module.css';

interface PasswordErrors {
  current?: string;
  next?: string;
  form?: string;
}

export const PasswordDialog: React.FC<PasswordDialogProps> = ({ isOpen, onClose, onSuccess }) => {
  const formId = useId();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [isLoading, setIsLoading] = useState(false);
  const [wasOpen, setWasOpen] = useState(isOpen);

  // Never keep passwords around between openings
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setCurrentPassword('');
      setNewPassword('');
      setErrors({});
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    const nextErrors: PasswordErrors = {};
    if (!currentPassword) nextErrors.current = 'Enter your current password';
    if (!newPassword) {
      nextErrors.next = 'Choose a new password';
    } else if (characterCount(newPassword.trim()) < VALIDATION.PASSWORD_MIN_LENGTH) {
      nextErrors.next = VALIDATION_MESSAGES.PASSWORD_LENGTH_ERROR;
    } else if (newPassword === currentPassword) {
      nextErrors.next = 'Pick a password different from your current one';
    }
    if (nextErrors.current || nextErrors.next) {
      setErrors(nextErrors);
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      if (res.success) {
        onSuccess();
        onClose();
      } else {
        setErrors({ form: res.error || "Couldn't change your password. Try again." });
      }
    } catch (err) {
      console.warn('[Settings] Password change failed', { code: getErrorCode(err) });
      const message = getRequestErrorMessage(err, "Couldn't change your password. Try again.");
      // A wrong current password belongs on that field
      if (err instanceof ApiError && err.errorCode === 'INVALID_PASSWORD') {
        setErrors({ current: message });
      } else {
        setErrors({ form: message });
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Change password"
      subtitle="Pick one you don't use anywhere else"
      icon={
        <span className={`${styles.toneIcon} ${styles.toneAmber}`}>
          <KeyRound size={20} strokeWidth={2.3} />
        </span>
      }
      maxWidth="400px"
      mobileLayout="dialog"
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            className={styles.footerButton}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={isLoading} className={styles.footerButton}>
            {isLoading ? 'Updating…' : 'Update'}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={handleSubmit} noValidate>
        {errors.form && (
          <div className={styles.formError} role="alert">
            {errors.form}
          </div>
        )}
        <PasswordInput
          label="Current password"
          value={currentPassword}
          onChange={(e) => {
            setCurrentPassword(e.target.value);
            setErrors((prev) => ({ ...prev, current: undefined, form: undefined }));
          }}
          placeholder="Enter current password"
          error={errors.current}
          autoComplete="current-password"
          autoFocus
        />
        <PasswordInput
          label="New password"
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
            setErrors((prev) => ({ ...prev, next: undefined, form: undefined }));
          }}
          placeholder="Enter new password"
          error={errors.next}
          helperText={`At least ${VALIDATION.PASSWORD_MIN_LENGTH} characters`}
          autoComplete="new-password"
          enterKeyHint="done"
        />
      </form>
    </Modal>
  );
};
