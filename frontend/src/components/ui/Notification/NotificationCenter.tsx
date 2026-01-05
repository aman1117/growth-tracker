/**
 * NotificationCenter Component
 *
 * Main notification component combining bell icon and dropdown panel.
 * Manages WebSocket connection and notification state.
 */

import React, { useState, useCallback } from 'react';
import { NotificationBell } from './NotificationBell';
import { NotificationPanel } from './NotificationPanel';
import { useWebSocket } from '../../../hooks';
import { useIsAuthenticated } from '../../../store';
import type { Notification } from '../../../types';
import styles from './Notification.module.css';

interface NotificationCenterProps {
  /** Callback when a notification is clicked */
  onNotificationClick?: (notification: Notification) => void;
  /** Callback when a username is clicked */
  onUsernameClick?: (username: string) => void;
  /** Close other dropdowns when opening */
  onOpen?: () => void;
}

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  onNotificationClick,
  onUsernameClick,
  onOpen,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const isAuthenticated = useIsAuthenticated();

  // Initialize WebSocket connection when authenticated
  useWebSocket({ enabled: isAuthenticated });

  const handleToggle = useCallback(() => {
    if (!isOpen) {
      onOpen?.();
    }
    setIsOpen((prev) => !prev);
  }, [isOpen, onOpen]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handleNotificationClick = useCallback(
    (notification: Notification) => {
      onNotificationClick?.(notification);
      // Close panel after clicking a notification
      setIsOpen(false);
    },
    [onNotificationClick]
  );

  const handleUsernameClick = useCallback(
    (username: string) => {
      onUsernameClick?.(username);
      // Close panel after clicking username
      setIsOpen(false);
    },
    [onUsernameClick]
  );

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className={styles.container}>
      <NotificationBell onClick={handleToggle} isOpen={isOpen} />
      <NotificationPanel
        isOpen={isOpen}
        onClose={handleClose}
        onNotificationClick={handleNotificationClick}
        onUsernameClick={handleUsernameClick}
      />
    </div>
  );
};

export default NotificationCenter;
