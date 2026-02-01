/**
 * LogoutButton Component
 *
 * Logout option row.
 */

import { LogOut } from 'lucide-react';
import React from 'react';

interface LogoutButtonProps {
  onLogout: () => void;
}

export const LogoutButton: React.FC<LogoutButtonProps> = ({ onLogout }) => {
  return (
    <div
      style={{
        padding: '0.5rem',
        borderRadius: '8px',
        cursor: 'pointer',
      }}
      onClick={onLogout}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-secondary)')}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <div
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <LogOut size={14} color="#ef4444" />
        </div>
        <span style={{ fontSize: '0.85rem', color: '#ef4444' }}>Logout</span>
      </div>
    </div>
  );
};
