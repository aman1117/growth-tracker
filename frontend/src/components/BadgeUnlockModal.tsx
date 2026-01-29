/**
 * BadgeUnlockModal Component
 *
 * Celebration modal when a new badge is unlocked with confetti animation.
 */

import confetti from 'canvas-confetti';
import React, { useCallback, useEffect } from 'react';

import type { Badge } from '../types/api';
import { getBadgeIconComponent } from '../utils/badgeIcons';
import styles from './BadgeUnlockModal.module.css';

export interface BadgeUnlockModalProps {
  badges: Badge[];
  isOpen: boolean;
  onClose: () => void;
}

export const BadgeUnlockModal: React.FC<BadgeUnlockModalProps> = ({ badges, isOpen, onClose }) => {
  const fireConfetti = useCallback(() => {
    // Fire confetti from both sides (reduced for smoother performance)
    const count = 80;
    const defaults = {
      origin: { y: 0.7 },
      zIndex: 10001,
    };

    function fire(particleRatio: number, opts: confetti.Options) {
      confetti({
        ...defaults,
        ...opts,
        particleCount: Math.floor(count * particleRatio),
      });
    }

    fire(0.3, {
      spread: 40,
      startVelocity: 45,
      origin: { x: 0.3, y: 0.7 },
    });

    fire(0.4, {
      spread: 60,
      origin: { x: 0.5, y: 0.7 },
    });

    fire(0.3, {
      spread: 40,
      startVelocity: 45,
      origin: { x: 0.7, y: 0.7 },
    });
  }, []);

  useEffect(() => {
    if (isOpen && badges.length > 0) {
      // Delay confetti slightly for better visual effect
      const timeout = setTimeout(() => {
        fireConfetti();
      }, 300);

      return () => clearTimeout(timeout);
    }
  }, [isOpen, badges.length, fireConfetti]);

  // Auto-close after 5 seconds
  useEffect(() => {
    if (isOpen) {
      const timeout = setTimeout(() => {
        onClose();
      }, 5000);

      return () => clearTimeout(timeout);
    }
  }, [isOpen, onClose]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  if (!isOpen || badges.length === 0) return null;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.celebration}>🎉</div>
        <h2 className={styles.title}>
          {badges.length === 1 ? 'Badge Unlocked!' : 'Badges Unlocked!'}
        </h2>

        <div className={styles.badgeList}>
          {badges.map((badge) => {
            const IconComponent = getBadgeIconComponent(badge.icon);
            return (
              <div
                key={badge.key}
                className={styles.badgeItem}
                style={{ '--badge-color': badge.color } as React.CSSProperties}
              >
                <div className={styles.badgeIcon}>
                  <IconComponent
                    size={48}
                    fill={badge.color}
                    color={badge.color}
                    strokeWidth={1.5}
                  />
                </div>
                <div className={styles.badgeInfo}>
                  <span className={styles.badgeName}>{badge.name}</span>
                  <span className={styles.badgeThreshold}>{badge.threshold} day streak</span>
                </div>
              </div>
            );
          })}
        </div>

        <button className={styles.closeButton} onClick={onClose}>
          Awesome!
        </button>
      </div>
    </div>
  );
};

export default BadgeUnlockModal;
