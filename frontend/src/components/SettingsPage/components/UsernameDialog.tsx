/**
 * Username Dialog
 *
 * Dialog for changing username with validation.
 */

import { AtSign } from 'lucide-react';
import React, { useId, useState } from 'react';

import { VALIDATION } from '../../../constants/validation';
import { api } from '../../../services/api';
import { Button, Input, Modal } from '../../ui';
import { getErrorCode, getRequestErrorMessage } from '../settingsForm';
import type { UsernameDialogProps } from '../SettingsPage.types';
import styles from './SettingsDialogs.module.css';

const validateUsername = (value: string): string | null => {
  if (
    value.length < VALIDATION.USERNAME_MIN_LENGTH ||
    value.length > VALIDATION.USERNAME_MAX_LENGTH
  ) {
    return `Username must be ${VALIDATION.USERNAME_MIN_LENGTH}-${VALIDATION.USERNAME_MAX_LENGTH} characters`;
  }
  if (!VALIDATION.USERNAME_PATTERN.test(value)) {
    return 'Only lowercase letters, numbers, _ and . allowed';
  }
  return null;
};

export const UsernameDialog: React.FC<UsernameDialogProps> = ({
  isOpen,
  onClose,
  currentUsername,
  onSuccess,
}) => {
  const formId = useId();
  const [username, setUsername] = useState(currentUsername);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [wasOpen, setWasOpen] = useState(isOpen);

  // Start from a fresh form every time the dialog opens
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setUsername(currentUsername);
      setError('');
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    const value = username.trim();
    const validationError = validateUsername(value);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (value === currentUsername) {
      onClose();
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/update-username', { new_username: value });
      if (res.success) {
        onSuccess(res.new_username);
        onClose();
      } else {
        setError(res.error || "Couldn't update your username. Try again.");
      }
    } catch (err) {
      console.warn('[Settings] Username update failed', { code: getErrorCode(err) });
      setError(getRequestErrorMessage(err, "Couldn't update your username. Try again."));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Change username"
      subtitle="This is how people find and mention you"
      icon={
        <span className={`${styles.toneIcon} ${styles.toneViolet}`}>
          <AtSign size={20} strokeWidth={2.3} />
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
            {isLoading ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={handleSubmit} noValidate>
        <Input
          label="Username"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value.toLowerCase());
            setError('');
          }}
          placeholder="your.username"
          icon={<AtSign size={18} strokeWidth={2.25} aria-hidden="true" />}
          error={error || undefined}
          helperText={`${VALIDATION.USERNAME_MIN_LENGTH}–${VALIDATION.USERNAME_MAX_LENGTH} characters: lowercase letters, numbers, _ and .`}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          spellCheck={false}
          enterKeyHint="done"
        />
      </form>
    </Modal>
  );
};
