/**
 * BadgeUnlockModal Component
 *
 * Celebration dialog shown when one or more streak badges are unlocked.
 * Fires brand-colored confetti (skipped for reduced motion) and auto-closes.
 */

import confetti from 'canvas-confetti';
import { PartyPopper } from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useBackDismiss } from '../hooks/useBackDismiss';
import { useEscapeKey } from '../hooks/useEscapeKey';
import type { Badge } from '../types/api';
import { getBadgeIconComponent } from '../utils/badgeIcons';
import styles from './BadgeUnlockModal.module.css';
import { Button } from './ui';

export interface BadgeUnlockModalProps {
  badges: Badge[];
  isOpen: boolean;
  onClose: () => void;
}

const AUTO_CLOSE_MS = 5000;
const CONFETTI_DELAY_MS = 300;
const CONFETTI_COLORS = ['#22c55e', '#14b8a6', '#6447f2', '#ec4899', '#f59e0b'];

export const BadgeUnlockModal: React.FC<BadgeUnlockModalProps> = ({ badges, isOpen, onClose }) => {
  const titleId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isVisible = isOpen && badges.length > 0;

  // Stable timers even when the parent passes a new onClose each render
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const fireConfetti = useCallback(() => {
    // Fire confetti from both sides (reduced for smoother performance)
    const count = 80;
    const defaults: confetti.Options = {
      origin: { y: 0.7 },
      zIndex: 10001,
      colors: CONFETTI_COLORS,
      disableForReducedMotion: true,
    };

    function fire(particleRatio: number, opts: confetti.Options) {
      confetti({
        ...defaults,
        ...opts,
        particleCount: Math.floor(count * particleRatio),
      });
    }

    fire(0.3, { spread: 40, startVelocity: 45, origin: { x: 0.3, y: 0.7 } });
    fire(0.4, { spread: 60, origin: { x: 0.5, y: 0.7 } });
    fire(0.3, { spread: 40, startVelocity: 45, origin: { x: 0.7, y: 0.7 } });
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    // Delay confetti slightly for better visual effect
    const timeout = setTimeout(fireConfetti, CONFETTI_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [isVisible, fireConfetti]);

  // Auto-close after a few seconds
  useEffect(() => {
    if (!isVisible) return;
    const timeout = setTimeout(() => onCloseRef.current(), AUTO_CLOSE_MS);
    return () => clearTimeout(timeout);
  }, [isVisible]);

  // Focus the primary action so Enter / Space dismisses
  useEffect(() => {
    if (isVisible) buttonRef.current?.focus({ preventScroll: true });
  }, [isVisible]);

  useEscapeKey(isVisible, onClose);
  useBackDismiss(isVisible, onClose);

  if (!isVisible) return null;

  // Spotlight the highest badge; list every badge when several unlock at once
  const sorted = [...badges].sort((a, b) => b.threshold - a.threshold);
  const hero = sorted[0];
  const HeroIcon = getBadgeIconComponent(hero.icon);
  const isMultiple = badges.length > 1;

  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ '--badge-color': hero.color } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.medallion} aria-hidden="true">
          <span className={styles.medallionRing} />
          <span className={styles.medallionCore}>
            <HeroIcon size={50} fill={hero.color} color={hero.color} strokeWidth={1.5} />
          </span>
        </div>

        <span className={styles.eyebrow}>
          <PartyPopper size={13} strokeWidth={2.5} aria-hidden="true" />
          {isMultiple ? `${badges.length} new badges` : 'New badge'}
        </span>

        <h2 id={titleId} className={styles.title}>
          {isMultiple ? 'Badges unlocked!' : 'Badge unlocked!'}
        </h2>

        {isMultiple ? (
          <ul className={styles.badgeList}>
            {sorted.map((badge) => {
              const IconComponent = getBadgeIconComponent(badge.icon);
              return (
                <li
                  key={badge.key}
                  className={styles.badgeItem}
                  style={{ '--badge-color': badge.color } as React.CSSProperties}
                >
                  <span className={styles.badgeItemIcon} aria-hidden="true">
                    <IconComponent
                      size={22}
                      fill={badge.color}
                      color={badge.color}
                      strokeWidth={1.5}
                    />
                  </span>
                  <span className={styles.badgeInfo}>
                    <span className={styles.badgeName}>{badge.name}</span>
                    <span className={styles.badgeThreshold}>{badge.threshold}-day streak</span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.heroText}>
            <span className={styles.heroName}>{hero.name}</span>
            <span className={styles.heroThreshold}>
              You kept a {hero.threshold}-day streak going
            </span>
          </p>
        )}

        <Button ref={buttonRef} size="lg" fullWidth onClick={onClose}>
          Awesome!
        </Button>
      </div>
    </div>,
    document.body
  );
};

export default BadgeUnlockModal;
