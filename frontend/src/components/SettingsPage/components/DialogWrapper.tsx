/**
 * Dialog Wrapper Component
 *
 * @deprecated Settings dialogs now use the shared `Modal` directly. Kept for compatibility:
 * renders its children in a compact, header-less Modal that is open while mounted.
 */

import React from 'react';

import { Modal } from '../../ui';
import type { DialogWrapperProps } from '../SettingsPage.types';
import styles from './SettingsDialogs.module.css';

export const DialogWrapper: React.FC<DialogWrapperProps> = ({ children, onClose }) => (
  <Modal isOpen onClose={onClose} showCloseButton={false} maxWidth="340px" mobileLayout="dialog">
    <div className={styles.legacyBody}>{children}</div>
  </Modal>
);
