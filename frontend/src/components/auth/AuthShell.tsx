/**
 * AuthShell
 *
 * Shared frame for every signed-out screen (login, register, forgot/reset
 * password, verify email): a playful emblem, a display title, a glass card and
 * an optional footer. Status screens pass `tone` + `icon` to swap the emblem
 * for a tinted status chip.
 */

import type { ReactNode } from 'react';
import React from 'react';

import { BrandLogo } from '../ui/BrandLogo';
import styles from './AuthShell.module.css';

export type AuthShellTone = 'brand' | 'success' | 'danger' | 'info';

export interface AuthShellProps {
  /** Main heading */
  title: ReactNode;
  /** Supporting line under the heading */
  subtitle?: ReactNode;
  /** Status icon; when omitted the brand emblem is shown */
  icon?: ReactNode;
  /** Color tone for the status icon chip */
  tone?: AuthShellTone;
  /** Card content */
  children?: ReactNode;
  /** Card-less action stack (status screens) */
  actions?: ReactNode;
  /** Content rendered below the card (secondary links) */
  footer?: ReactNode;
  /** Center the card content (status screens) */
  centered?: boolean;
  /** Announce the heading region politely (for async status changes) */
  live?: boolean;
}

/** The app mark: the brand app-icon tile (mirrors the installed app icon) */
const BrandEmblem: React.FC = () => (
  <span className={styles.emblem} aria-hidden="true">
    <BrandLogo variant="icon" size="xl" animated label="" />
  </span>
);

export const AuthShell: React.FC<AuthShellProps> = ({
  title,
  subtitle,
  icon,
  tone = 'brand',
  children,
  actions,
  footer,
  centered = false,
  live = false,
}) => {
  return (
    <div className={styles.shell}>
      <div className={styles.hero} aria-live={live ? 'polite' : undefined}>
        {icon ? (
          <span className={`${styles.statusIcon} ${styles[tone]}`} aria-hidden="true">
            {icon}
          </span>
        ) : (
          <BrandEmblem />
        )}
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>

      {children && (
        <div className={`${styles.card} ${centered ? styles.centered : ''}`}>{children}</div>
      )}

      {actions && <div className={styles.actions}>{actions}</div>}

      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  );
};

export default AuthShell;
