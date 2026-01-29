import { Moon, Sun } from 'lucide-react';
import React from 'react';

import { useTheme } from '../store';

export const ThemeToggle: React.FC = () => {
  const { isDark, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      style={{
        width: '36px',
        height: '36px',
        borderRadius: '50%',
        backgroundColor: 'var(--avatar-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: '0.9rem',
        color: 'var(--text-primary)',
        border: 'none',
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
        transition: 'background-color 0.3s ease',
      }}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <div
        style={{
          position: 'absolute',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          transform: isDark ? 'rotate(0deg) scale(1)' : 'rotate(-90deg) scale(0)',
          opacity: isDark ? 1 : 0,
        }}
      >
        <Sun size={16} strokeWidth={2} />
      </div>
      <div
        style={{
          position: 'absolute',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          transform: isDark ? 'rotate(90deg) scale(0)' : 'rotate(0deg) scale(1)',
          opacity: isDark ? 0 : 1,
        }}
      >
        <Moon size={16} strokeWidth={2} />
      </div>
    </button>
  );
};
