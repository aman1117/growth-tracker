/**
 * Toast Component (moved from components to ui)
 *
 * Notification toast with auto-dismiss and portal support.
 */

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { CheckCircle, XCircle, X } from 'lucide-react';
import styles from './Toast.module.css';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastProps {
  /** Toast message */
  message: string;
  /** Toast type */
  type: ToastType;
  /** Callback when toast should close */
  onClose: () => void;
  /** Auto-dismiss duration in ms */
  duration?: number;
}

export const Toast: React.FC<ToastProps> = ({
  message,
  type,
  onClose,
  duration = 3000,
}) => {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(onClose, 200);
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(onClose, 200);
  };

  const Icon = type === 'success' ? CheckCircle : XCircle;

  return ReactDOM.createPortal(
    <div
      className={`${styles.toast} ${styles[type]} ${isExiting ? styles.exiting : ''}`}
    >
      <Icon size={18} className={styles.icon} />
      <span className={styles.message}>{message}</span>
      <button className={styles.closeButton} onClick={handleClose}>
        <X size={16} />
      </button>
    </div>,
    document.body
  );
};

export default Toast;
