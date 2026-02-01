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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 24px',
        textAlign: 'center',
        margin: '8px',
        background: 'var(--tile-glass-bg)',
        backdropFilter: 'blur(var(--tile-glass-blur))',
        WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
        borderRadius: '24px',
        border: '1px solid var(--tile-glass-border)',
        boxShadow: 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
      }}
    >
      <div
        style={{
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          background:
            'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)',
          border: '2px solid var(--tile-glass-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '12px',
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.1)',
        }}
      >
        <Lock size={24} style={{ color: 'var(--text-secondary)' }} />
      </div>
      <h3
        style={{
          margin: '0 0 4px 0',
          fontSize: '1rem',
          fontWeight: 600,
          color: 'var(--text-primary)',
        }}
      >
        Private Account
      </h3>
      <p
        style={{
          margin: '0 0 16px 0',
          fontSize: '0.8rem',
          color: 'var(--text-secondary)',
        }}
      >
        @{targetUsername}'s activity is hidden
      </p>

      {/* Show badges (always public) */}
      {earnedBadges.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '8px',
            paddingTop: '16px',
            borderTop: '1px solid var(--tile-glass-border)',
            width: '100%',
          }}
        >
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Badges earned</span>
          <div
            style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}
          >
            {earnedBadges.map((badge) => (
              <div
                key={badge.key}
                title={`${badge.name} - ${badge.threshold} day streak`}
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: `color-mix(in srgb, ${badge.color} 15%, var(--bg-secondary))`,
                  border: `1px solid ${badge.color}40`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {renderBadgeIcon(badge.icon, badge.color, 20)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
