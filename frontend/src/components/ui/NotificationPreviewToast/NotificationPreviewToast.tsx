/**
 * NotificationPreviewToast Component
 *
 * Rich notification preview that slides in from the top when a real-time
 * notification arrives via WebSocket. Shows type-specific icon, title, body,
 * and is clickable to navigate to the relevant content.
 *
 * Features:
 * - Glassmorphism floating design
 * - Spring slide-in / slide-out animation
 * - Swipe-to-dismiss gesture (mobile)
 * - Haptic feedback on supported devices
 * - Auto-dismiss after configurable duration
 * - Click to navigate + dismiss
 * - Escape key to dismiss
 */

import {
  AlertTriangle,
  AtSign,
  Camera,
  Flame,
  Heart,
  Megaphone,
  MessageCircle,
  Reply,
  Trophy,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';

import type { Notification, NotificationType } from '../../../types';
import styles from './NotificationPreviewToast.module.css';

const NOTIFICATION_ICONS: Record<NotificationType, React.ReactNode> = {
  like_received: <Heart size={16} className={styles.iconLike} />,
  story_liked: <Heart size={16} className={styles.iconLike} />,
  badge_unlocked: <Trophy size={16} className={styles.iconBadge} />,
  streak_milestone: <Flame size={16} className={styles.iconStreak} />,
  streak_at_risk: <AlertTriangle size={16} className={styles.iconWarning} />,
  system_announcement: <Megaphone size={16} className={styles.iconSystem} />,
  new_follower: <UserPlus size={16} className={styles.iconFollow} />,
  follow_request: <UserPlus size={16} className={styles.iconFollow} />,
  follow_accepted: <UserCheck size={16} className={styles.iconFollow} />,
  photo_uploaded: <Camera size={16} className={styles.iconPhoto} />,
  comment_received: <MessageCircle size={16} className={styles.iconFollow} />,
  comment_reply: <Reply size={16} className={styles.iconFollow} />,
  comment_mention: <AtSign size={16} className={styles.iconFollow} />,
  comment_liked: <Heart size={16} className={styles.iconLike} />,
};

export interface NotificationPreviewToastProps {
  notification: Notification;
  onClose: () => void;
  onClick: (notification: Notification) => void;
  duration?: number;
}

export const NotificationPreviewToast: React.FC<NotificationPreviewToastProps> = ({
  notification,
  onClose,
  onClick,
  duration = 5000,
}) => {
  const [isExiting, setIsExiting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const toastRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const startX = useRef(0);

  const handleClose = useCallback(() => {
    setIsExiting(true);
    setTimeout(onClose, 250);
  }, [onClose]);

  // Haptic feedback on mount
  useEffect(() => {
    if (navigator.vibrate) {
      navigator.vibrate(100);
    }
  }, []);

  // Auto-dismiss timer
  useEffect(() => {
    if (duration <= 0) return;
    const timer = setTimeout(handleClose, duration);
    return () => clearTimeout(timer);
  }, [duration, handleClose]);

  // Escape key to dismiss
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // Prevent background scroll during swipe
  useEffect(() => {
    const toast = toastRef.current;
    if (!toast) return;

    const handleTouchMoveNative = (e: TouchEvent) => {
      if (isDragging) e.preventDefault();
    };

    toast.addEventListener('touchmove', handleTouchMoveNative, { passive: false });
    return () => toast.removeEventListener('touchmove', handleTouchMoveNative);
  }, [isDragging]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    setIsDragging(true);
    startY.current = e.touches[0].clientY;
    startX.current = e.touches[0].clientX;
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragging) return;
      const diffY = startY.current - e.touches[0].clientY;
      const diffX = Math.abs(e.touches[0].clientX - startX.current);
      // Only allow upward swipe
      if (diffY > 0 && diffY > diffX) {
        setDragOffset(Math.min(diffY, 100));
      }
    },
    [isDragging]
  );

  const handleTouchEnd = useCallback(() => {
    if (dragOffset > 30) {
      onClose();
    } else {
      setDragOffset(0);
      setIsDragging(false);
    }
  }, [dragOffset, onClose]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't navigate if clicking the close button
      if ((e.target as HTMLElement).closest(`.${styles.closeButton}`)) return;
      onClick(notification);
      onClose();
    },
    [onClick, notification, onClose]
  );

  const icon = NOTIFICATION_ICONS[notification.type] || <Megaphone size={16} />;

  const toastStyle: React.CSSProperties = isDragging
    ? {
        transform:
          dragOffset > 30
            ? 'translateX(-50%) translateY(-100px)'
            : `translateX(-50%) translateY(-${dragOffset}px)`,
        opacity: dragOffset > 30 ? 0 : Math.max(0.3, 1 - dragOffset / 100),
        transition: dragOffset > 30 ? 'all 0.15s ease-out' : 'none',
      }
    : {};

  const toastElement = (
    <div
      ref={toastRef}
      className={`${styles.previewToast} ${isExiting ? styles.exiting : ''} ${isDragging ? styles.dragging : ''}`}
      style={toastStyle}
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      role="alert"
      aria-live="polite"
    >
      <div className={styles.iconWrapper}>{icon}</div>

      <div className={styles.content}>
        <p className={styles.title}>{notification.title}</p>
        {notification.body && <p className={styles.body}>{notification.body}</p>}
      </div>

      <button
        className={styles.closeButton}
        onClick={(e) => {
          e.stopPropagation();
          handleClose();
        }}
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );

  return ReactDOM.createPortal(toastElement, document.body);
};
