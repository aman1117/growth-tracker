/**
 * Settings Section Component
 *
 * A titled group of settings rows on one glass card.
 */

import React, { useId } from 'react';

import type { SettingsSectionProps } from '../SettingsPage.types';
import styles from './SettingsSection.module.css';

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  ariaLabel,
  footnote,
  children,
  className = '',
}) => {
  const titleId = useId();

  return (
    <section
      className={`${styles.section} ${className}`}
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : ariaLabel}
    >
      {title && (
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
      )}
      <div className={styles.card}>{children}</div>
      {footnote && <p className={styles.footnote}>{footnote}</p>}
    </section>
  );
};
