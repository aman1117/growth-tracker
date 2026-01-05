/**
 * NotificationPanel Component
 *
 * Dropdown panel showing list of notifications with glassmorphism styling.
 * Features:
 * - Frosted glass background
 * - Mark all as read
 * - Infinite scroll loading
 * - Empty state
 * - Connection status indicator
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, RefreshCw, X } from 'lucide-react';
import { useNotificationStore } from '../../../store';
import { NotificationItem } from './NotificationItem';
import type { Notification } from '../../../types';
import styles from './Notification.module.css';

interface NotificationPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onNotificationClick?: (notification: Notification) => void;
  onUsernameClick?: (username: string) => void;
}

const CLOSE_ANIMATION_DURATION = 150;

export const NotificationPanel: React.FC<NotificationPanelProps> = ({
  isOpen,
  onClose,
  onNotificationClick,
  onUsernameClick,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [shouldRender, setShouldRender] = useState(isOpen);

  const {
    notifications,
    unreadCount,
    isLoading,
    hasMore,
    deletingIds,
    fetchNotifications,
    markAsRead,
    markAllAsRead,
    startDeleting,
    deleteNotification,
  } = useNotificationStore();

  // Handle open/close with animation
  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
    } else if (shouldRender) {
      setIsClosing(true);
      const timer = setTimeout(() => {
        setShouldRender(false);
        setIsClosing(false);
      }, CLOSE_ANIMATION_DURATION);
      return () => clearTimeout(timer);
    }
  }, [isOpen, shouldRender]);

  // Fetch notifications when panel opens
  useEffect(() => {
    if (isOpen && notifications.length === 0) {
      fetchNotifications(true);
    }
  }, [isOpen, notifications.length, fetchNotifications]);

  // Close on outside click and Escape key
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Infinite scroll
  const handleScroll = useCallback(() => {
    if (!listRef.current || isLoading || !hasMore) return;

    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      fetchNotifications();
    }
  }, [isLoading, hasMore, fetchNotifications]);

  const handleMarkAllAsRead = async () => {
    try {
      await markAllAsRead();
    } catch (error) {
      console.error('Failed to mark all as read:', error);
    }
  };

  const handleRefresh = () => {
    fetchNotifications(true);
  };

  // Check if mobile (SSR-safe)
  const [isMobile, setIsMobile] = useState(() => 
    typeof window !== 'undefined' ? window.innerWidth <= 640 : false
  );
  
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 640);
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  if (!shouldRender) return null;

  const panelClasses = [
    styles.panel,
    isMobile && styles.panelMobile,
    isClosing && styles.panelClosing,
  ].filter(Boolean).join(' ');

  const panelContent = (
    <>
      {/* Mobile overlay backdrop */}
      {isMobile && <div className={`${styles.mobileOverlay} ${isClosing ? styles.mobileOverlayClosing : ''}`} onClick={onClose} />}
      
      <div ref={panelRef} className={panelClasses}>
        {/* Header */}
        <div className={styles.panelHeader}>
          <h3 className={styles.panelTitle}>
            Notifications
            {unreadCount > 0 && (
              <span className={styles.unreadBadge}>{unreadCount}</span>
            )}
          </h3>
        
          <div className={styles.headerActions}>
            {/* Refresh Button */}
            <button
              className={styles.headerButton}
              onClick={handleRefresh}
              disabled={isLoading}
              title="Refresh"
            >
              <RefreshCw size={14} className={isLoading ? styles.spinning : ''} />
            </button>

            {/* Mark All Read */}
            {unreadCount > 0 && (
              <button
                className={styles.headerButton}
                onClick={handleMarkAllAsRead}
                title="Mark all as read"
              >
                <Check size={14} />
              </button>
            )}

            {/* Close button for mobile */}
            {isMobile && (
              <button
                className={styles.headerButton}
                onClick={onClose}
                title="Close"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Notification List */}
        <div
          ref={listRef}
          className={styles.panelList}
          onScroll={handleScroll}
        >
          {isLoading && notifications.length === 0 ? (
            <div className={styles.initialLoading}>
              <RefreshCw size={20} className={styles.spinning} />
              <span>Loading notifications...</span>
            </div>
          ) : notifications.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyTitle}>No notifications yet</p>
              <p className={styles.emptySubtitle}>
                When you receive notifications, they'll appear here
              </p>
            </div>
          ) : (
            <>
              {notifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onMarkAsRead={markAsRead}
                  onStartDeleting={startDeleting}
                  onDelete={deleteNotification}
                  onClick={onNotificationClick}
                  onUsernameClick={onUsernameClick}
                  isDeleting={!!deletingIds[notification.id]}
                />
              ))}

              {isLoading && (
                <div className={styles.loadingMore}>
                  <RefreshCw size={16} className={styles.spinning} />
                  <span>Loading...</span>
                </div>
              )}

              {!hasMore && notifications.length > 0 && (
                <div className={styles.endOfList}>
                  That's all your notifications
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );

  // On mobile, render via portal to escape parent container
  if (isMobile) {
    return createPortal(panelContent, document.body);
  }

  return panelContent;
};

export default NotificationPanel;
