/**
 * NotificationBell Component
 *
 * Bell icon button with unread count badge.
 * Toggles the notification dropdown panel.
 */

import { Bell } from 'lucide-react';
import React from 'react';

import { useUnreadCount } from '../../../store';
import styles from './Notification.module.css';

interface NotificationBellProps {
  onClick: () => void;
  isOpen: boolean;
}

export const NotificationBell: React.FC<NotificationBellProps> = ({ onClick, isOpen }) => {
  const unreadCount = useUnreadCount();

  return (
    <button
      className={`${styles.bellButton} ${isOpen ? styles.bellActive : ''}`}
      onClick={onClick}
      aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      aria-expanded={isOpen}
    >
      <Bell size={22} strokeWidth={1.8} />
      {unreadCount > 0 && (
        <span className={styles.badge} aria-hidden="true">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
};

export default NotificationBell;
