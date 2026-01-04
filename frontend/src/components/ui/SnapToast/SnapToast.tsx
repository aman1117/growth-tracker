/**
 * SnapToast Component - Snapchat-style Toast POC
 *
 * Features:
 * - Pill-shaped, minimal design like Snapchat in-app toasts
 * - Frosted glass backdrop blur effect
 * - Smooth spring animation (slide down with bounce)
 * - Auto-dismiss with progress indicator
 * - Optional icon support
 * - Swipe-to-dismiss gesture support
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { Check, X, Info, AlertTriangle, Zap } from 'lucide-react';
import styles from './SnapToast.module.css';

export type SnapToastType = 'success' | 'error' | 'info' | 'warning' | 'neutral';

export interface SnapToastProps {
  /** Toast message - keep it short! */
  message: string;
  /** Toast type determines the accent color and icon */
  type?: SnapToastType;
  /** Custom icon (overrides default type icon) */
  icon?: React.ReactNode;
  /** Show icon */
  showIcon?: boolean;
  /** Callback when toast closes */
  onClose: () => void;
  /** Auto-dismiss duration in ms (default: 2500ms for Snapchat feel) */
  duration?: number;
  /** Show progress bar */
  showProgress?: boolean;
  /** Allow swipe to dismiss */
  swipeable?: boolean;
  /** Position */
  position?: 'top' | 'bottom';
}

const typeIcons: Record<SnapToastType, React.ReactNode> = {
  success: <Check size={16} strokeWidth={3} />,
  error: <X size={16} strokeWidth={3} />,
  info: <Info size={16} strokeWidth={2.5} />,
  warning: <AlertTriangle size={16} strokeWidth={2.5} />,
  neutral: <Zap size={16} strokeWidth={2.5} />,
};

export const SnapToast: React.FC<SnapToastProps> = ({
  message,
  type = 'neutral',
  icon,
  showIcon = true,
  onClose,
  duration = 2500,
  showProgress = false,
  swipeable = true,
  position = 'top',
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

  // Auto-dismiss timer
  useEffect(() => {
    if (duration <= 0) return;
    
    const timer = setTimeout(() => {
      handleClose();
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, handleClose]);

  // Swipe gesture handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!swipeable) return;
    setIsDragging(true);
    startY.current = e.touches[0].clientY;
    startX.current = e.touches[0].clientX;
  }, [swipeable]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging || !swipeable) return;
    
    const currentY = e.touches[0].clientY;
    const currentX = e.touches[0].clientX;
    const diffY = position === 'top' 
      ? startY.current - currentY 
      : currentY - startY.current;
    const diffX = Math.abs(currentX - startX.current);
    
    // Only allow vertical swipe (up for top position, down for bottom)
    if (diffY > 0 && diffY > diffX) {
      setDragOffset(Math.min(diffY, 100));
    }
  }, [isDragging, swipeable, position]);

  const handleTouchEnd = useCallback(() => {
    if (!swipeable) return;
    setIsDragging(false);
    
    if (dragOffset > 50) {
      handleClose();
    } else {
      setDragOffset(0);
    }
  }, [swipeable, dragOffset, handleClose]);

  const displayIcon = icon || typeIcons[type];

  const toastStyle: React.CSSProperties = {
    transform: isDragging 
      ? `translateX(-50%) translateY(${position === 'top' ? -dragOffset : dragOffset}px)`
      : undefined,
    opacity: isDragging ? Math.max(0.3, 1 - dragOffset / 100) : undefined,
    transition: isDragging ? 'none' : undefined,
  };

  const toastElement = (
    <div
      ref={toastRef}
      className={`
        ${styles.snapToast} 
        ${styles[type]} 
        ${styles[position]}
        ${isExiting ? styles.exiting : ''} 
        ${isDragging ? styles.dragging : ''}
      `}
      style={toastStyle}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      role="alert"
      aria-live="polite"
    >
      {/* Icon */}
      {showIcon && (
        <span className={styles.iconWrapper}>
          {displayIcon}
        </span>
      )}
      
      {/* Message */}
      <span className={styles.message}>{message}</span>
      
      {/* Progress bar */}
      {showProgress && duration > 0 && (
        <div className={styles.progressContainer}>
          <div 
            className={styles.progressBar} 
            style={{ animationDuration: `${duration}ms` }}
          />
        </div>
      )}
    </div>
  );

  return ReactDOM.createPortal(toastElement, document.body);
};

export default SnapToast;
