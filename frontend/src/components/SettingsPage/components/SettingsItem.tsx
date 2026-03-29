/**
 * Settings Item Component
 *
 * Reusable settings row with icon, label, value, and chevron.
 */

import { ChevronRight } from 'lucide-react';
import React from 'react';

import type { SettingsItemProps } from '../SettingsPage.types';
import styles from './SettingsItem.module.css';

export const SettingsItem: React.FC<SettingsItemProps> = ({
  icon,
  label,
  value,
  onClick,
  showBorder,
  iconColor = '#3b82f6',
  iconBg = 'rgba(59, 130, 246, 0.1)',
}) => (
  <button onClick={onClick} className={`${styles.button} ${showBorder ? '' : styles.noBorder}`}>
    <div className={styles.iconBox} style={{ backgroundColor: iconBg, color: iconColor }}>
      {icon}
    </div>
    <div className={styles.content}>
      <div className={styles.label}>{label}</div>
      {value && <div className={styles.value}>{value}</div>}
    </div>
    <ChevronRight size={18} color="var(--text-secondary)" />
  </button>
);
