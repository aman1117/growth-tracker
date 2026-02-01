/**
 * ThemeToggle Component
 *
 * Theme switch option row.
 */

import { Palette } from 'lucide-react';
import React from 'react';

interface ThemeToggleProps {
  theme: string;
  onToggle: () => void;
}

export const ThemeToggle: React.FC<ThemeToggleProps> = ({ theme, onToggle }) => {
  return (
    <div
      style={{
        padding: '0.5rem',
        borderRadius: '8px',
        marginBottom: '0.125rem',
        cursor: 'pointer',
      }}
      onClick={onToggle}
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
          <Palette size={14} color="var(--text-secondary)" />
        </div>
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>Theme</span>
        </div>
        <span
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-secondary)',
            textTransform: 'capitalize',
          }}
        >
          {theme}
        </span>
      </div>
    </div>
  );
};
