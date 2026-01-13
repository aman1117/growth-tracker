/**
 * Modal Component
 *
 * Reusable modal dialog with backdrop and animations.
 * Uses React Portal to render at document body level for proper stacking.
 * Features glass-panel styling with design tokens.
 */

import React, { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import styles from './Modal.module.css';

export type ModalSize = 'small' | 'medium' | 'large' | 'fullscreen';

export interface ModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Modal title */
  title?: string;
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
  /** Footer content */
  footer?: ReactNode;
  /** Additional CSS class */
  className?: string;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  showCloseButton = true,
  closeOnBackdrop = true,
  closeOnEscape = true,
  size = 'medium',
  maxWidth,
  footer,
  className,
}) => {
  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEscape) {
        onClose();
      }
    },
    [onClose, closeOnEscape]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleEscape]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && closeOnBackdrop) {
      onClose();
    }
  };

  const modalContent = (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div 
        className={`${styles.modal} ${styles[size]} ${className || ''}`} 
        style={maxWidth ? { maxWidth } : undefined}
      >
        {(title || showCloseButton) && (
          <div className={styles.header}>
            {title && <h2 className={styles.title}>{title}</h2>}
            {showCloseButton && (
              <button
                className={styles.closeButton}
                onClick={onClose}
                aria-label="Close"
              >
                <X size={18} />
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
