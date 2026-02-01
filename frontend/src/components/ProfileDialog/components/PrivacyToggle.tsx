/**
 * PrivacyToggle Component
 *
 * Private account toggle switch.
 */

import { Lock } from 'lucide-react';
import React from 'react';

interface PrivacyToggleProps {
  isPrivate: boolean;
  isLoading: boolean;
  onToggle: () => void;
}

export const PrivacyToggle: React.FC<PrivacyToggleProps> = ({ isPrivate, isLoading, onToggle }) => {
  return (
    <div
      style={{
        padding: '0.5rem',
        borderRadius: '8px',
        marginBottom: '0.125rem',
        cursor: isLoading ? 'not-allowed' : 'pointer',
        opacity: isLoading ? 0.7 : 1,
      }}
      onClick={() => !isLoading && onToggle()}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-secondary)')}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <div
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            backgroundColor: 'var(--bg-secondary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Lock size={14} color="var(--text-secondary)" />
        </div>
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>Private account</span>
        </div>
        <div
          style={{
            width: '36px',
            height: '20px',
            borderRadius: '10px',
            backgroundColor: isPrivate ? 'var(--accent)' : 'var(--bg-secondary)',
            border: isPrivate ? 'none' : '1px solid var(--border)',
            position: 'relative',
            transition: 'background-color 0.2s',
          }}
        >
          <div
            style={{
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              backgroundColor: isPrivate ? 'white' : 'var(--text-secondary)',
              position: 'absolute',
              top: '2px',
              left: isPrivate ? '18px' : '2px',
              transition: 'left 0.2s, background-color 0.2s',
            }}
          />
        </div>
      </div>
    </div>
  );
};
