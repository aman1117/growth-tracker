import { Moon, Sun } from 'lucide-react';
import React from 'react';

import { gl } from '../services/goodlogs';
import { useTheme } from '../store';
import styles from './ThemeToggle.module.css';

export const ThemeToggle: React.FC = () => {
  const { isDark, toggleTheme } = useTheme();

  const handleToggle = () => {
    gl.track('theme_toggled', { properties: { to: isDark ? 'light' : 'dark' } });
    toggleTheme();
  };

  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={`${styles.toggle} ${isDark ? styles.dark : ''}`}
      aria-label={label}
      title={label}
    >
      <span className={`${styles.icon} ${styles.sun}`} aria-hidden="true">
        <Sun size={18} strokeWidth={2} />
      </span>
      <span className={`${styles.icon} ${styles.moon}`} aria-hidden="true">
        <Moon size={18} strokeWidth={2} />
      </span>
    </button>
  );
};
