/**
 * Bio Dialog
 *
 * Dialog for editing user bio. The limit is counted the way the server counts it
 * (UTF-8 bytes), so emoji-heavy bios are never rejected after looking valid.
 */

import { PenLine } from 'lucide-react';
import React, { useId, useState } from 'react';

import { VALIDATION } from '../../../constants/validation';
import { api } from '../../../services/api';
import { Button, Modal } from '../../ui';
import {
  clampToUtf8Bytes,
  getErrorCode,
  getRequestErrorMessage,
  utf8Length,
} from '../settingsForm';
import type { BioDialogProps } from '../SettingsPage.types';
import styles from './SettingsDialogs.module.css';

const MAX_BIO = VALIDATION.BIO_MAX_LENGTH;

export const BioDialog: React.FC<BioDialogProps> = ({ isOpen, onClose, currentBio, onSuccess }) => {
  const formId = useId();
  const textareaId = useId();
  const messageId = useId();
  const [bio, setBio] = useState(currentBio);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [wasOpen, setWasOpen] = useState(isOpen);

  // Start from the saved bio every time the dialog opens
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setBio(currentBio);
      setError('');
    }
  }

  const used = utf8Length(bio.trim());
  // Bytes exceed UTF-16 length only when the bio contains non-ASCII characters
  const hasWideCharacters = used > bio.trim().length;
  const counterClass =
    used >= MAX_BIO ? styles.counterFull : used >= MAX_BIO - 15 ? styles.counterNear : '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    const trimmedBio = bio.trim();
    if (utf8Length(trimmedBio) > MAX_BIO) {
      setError(`Bio must be ${MAX_BIO} characters or less`);
      return;
    }

    if (trimmedBio === currentBio.trim()) {
      onClose();
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/update-bio', { bio: trimmedBio });
      if (res.success) {
        onSuccess(res.bio || '');
        onClose();
      } else {
        setError(res.error || "Couldn't update your bio. Try again.");
      }
    } catch (err) {
      console.warn('[Settings] Bio update failed', { code: getErrorCode(err) });
      setError(getRequestErrorMessage(err, "Couldn't update your bio. Try again."));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Edit bio"
      subtitle="Tell people what you're growing"
      icon={
        <span className={`${styles.toneIcon} ${styles.tonePink}`}>
          <PenLine size={20} strokeWidth={2.3} />
        </span>
      }
      maxWidth="420px"
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
        <div className={styles.field}>
          <label htmlFor={textareaId} className="sr-only">
            Bio
          </label>
          <textarea
            id={textareaId}
            className={`${styles.textarea} ${error ? styles.textareaError : ''}`}
            value={bio}
            onChange={(e) => {
              setBio(clampToUtf8Bytes(e.target.value, MAX_BIO));
              setError('');
            }}
            placeholder="e.g. Reading 20 pages a day and learning to code 📚"
            rows={4}
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={messageId}
          />
          <div className={styles.fieldMeta}>
            <span
              id={messageId}
              className={`${styles.fieldMessage} ${error ? styles.fieldMessageError : ''}`}
              role={error ? 'alert' : undefined}
            >
              {error || (hasWideCharacters ? 'Emoji and symbols count as more than one.' : '')}
            </span>
            <span className={`${styles.counter} ${counterClass}`} aria-hidden="true">
              {used}/{MAX_BIO}
            </span>
          </div>
        </div>
      </form>
    </Modal>
  );
};
