/**
 * NotificationsBlockedGuide Component
 *
 * Modal guide for enabling notifications when permission is blocked (or, on iOS Safari,
 * when the app must be installed first).
 */

import { BellOff } from 'lucide-react';
import React from 'react';

import { Button, Modal } from '../../ui';
import styles from '../PushNotificationSettings.module.css';
import type { NotificationsBlockedGuideProps } from '../PushNotificationSettings.types';
import { getBlockedGuide, getPushPlatform } from '../pushPlatform';

export const NotificationsBlockedGuide: React.FC<NotificationsBlockedGuideProps> = ({
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  const { title, steps } = getBlockedGuide(getPushPlatform());

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      subtitle="It only takes a few taps"
      icon={
        <span className={styles.guideIcon}>
          <BellOff size={20} strokeWidth={2.3} />
        </span>
      }
      maxWidth="400px"
      footer={
        <Button type="button" onClick={onClose} className={styles.guideButton}>
          Got it
        </Button>
      }
    >
      <ol className={styles.steps}>
        {steps.map((step, index) => (
          <li key={step} className={styles.step}>
            <span className={styles.stepNumber} aria-hidden="true">
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </Modal>
  );
};
