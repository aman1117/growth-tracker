/**
 * Settings Item Component
 *
 * Reusable settings row with icon, label, value, and chevron.
 */

import { ChevronRight } from 'lucide-react';
import React from 'react';

import type { SettingsItemProps } from '../SettingsPage.types';

export const SettingsItem: React.FC<SettingsItemProps> = ({
  icon,
  label,
  value,
  onClick,
  showBorder,
  iconColor = '#3b82f6',
  iconBg = 'rgba(59, 130, 246, 0.1)',
}) => (
  <button
    onClick={onClick}
    style={{
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      padding: '0.75rem 1rem',
      gap: '0.75rem',
      background: 'none',
      border: 'none',
      borderBottom: showBorder ? '1px solid var(--border)' : 'none',
      cursor: 'pointer',
      textAlign: 'left',
      transition: 'background-color 0.2s',
    }}
    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-secondary)')}
    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
  >
    <div
      style={{
        width: '32px',
        height: '32px',
        borderRadius: '8px',
        backgroundColor: iconBg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: iconColor,
      }}
    >
      {icon}
    </div>
    <div style={{ flex: 1 }}>
      <div
        style={{
          fontSize: '0.875rem',
          fontWeight: 500,
          color: 'var(--text-primary)',
        }}
      >
        {label}
      </div>
      {value && (
        <div
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-secondary)',
          }}
        >
          {value}
        </div>
      )}
    </div>
    <ChevronRight size={18} color="var(--text-secondary)" />
  </button>
);
