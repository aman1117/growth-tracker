/**
 * PrivateAccountView Component
 *
 * Displays a locked profile view for private accounts.
 * Shows badges (which are always public) even for private profiles.
 */

import { Lock } from 'lucide-react';
import React from 'react';

import type { Badge } from '../../../types/api';
import { renderBadgeIcon } from '../../../utils/badgeIcons';
import styles from './PrivateAccountView.module.css';

interface PrivateAccountViewProps {
  targetUsername: string;
  badges: Badge[];
}

export const PrivateAccountView: React.FC<PrivateAccountViewProps> = ({
  targetUsername,
  badges,
}) => {
  const earnedBadges = badges.filter((b) => b.earned);

  return (
    <section className={styles.card} aria-labelledby="private-account-title">
      <span className={styles.lockIcon} aria-hidden="true">
        <Lock size={26} strokeWidth={2.25} />
      </span>
      <h3 id="private-account-title" className={styles.title}>
        This account is private
      </h3>
      <p className={styles.subtitle}>Follow @{targetUsername} to see their days and stories.</p>

      {/* Show badges (always public) */}
      {earnedBadges.length > 0 && (
        <div className={styles.badges}>
          <span className={styles.badgesLabel}>Badges earned</span>
          <ul className={styles.badgeList}>
            {earnedBadges.map((badge) => (
              <li
                key={badge.key}
                className={styles.badge}
                style={{ '--badge-color': badge.color } as React.CSSProperties}
                title={`${badge.name} - ${badge.threshold} day streak`}
              >
                {renderBadgeIcon(badge.icon, badge.color, 20)}
                <span className="sr-only">{badge.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
