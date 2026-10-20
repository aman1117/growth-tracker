/**
 * Settings Item Component
 *
 * Reusable settings row: tinted icon chip, label, optional secondary line, and a
 * trailing slot (chevron, count badge, external-link icon, or a custom control).
 * Renders as a button (onClick), link (href) or static row (e.g. holding a switch).
 */

import { ChevronRight, ExternalLink } from 'lucide-react';
import React from 'react';

import type { SettingsItemProps, SettingsTone } from '../SettingsPage.types';
import styles from './SettingsItem.module.css';

const TONE_CLASS: Record<SettingsTone, string> = {
  violet: styles.toneViolet,
  indigo: styles.toneIndigo,
  sky: styles.toneSky,
  teal: styles.toneTeal,
  green: styles.toneGreen,
  amber: styles.toneAmber,
  orange: styles.toneOrange,
  pink: styles.tonePink,
  red: styles.toneRed,
  slate: styles.toneSlate,
};

export const SettingsItem: React.FC<SettingsItemProps> = ({
  icon,
  label,
  value,
  onClick,
  href,
  external = false,
  iconColor,
  iconBg,
  tone = 'violet',
  trailing,
  danger = false,
  badge,
  controlId,
  children,
}) => {
  const isInteractive = !!(href || onClick);
  const chipStyle =
    iconColor || iconBg ? ({ color: iconColor, background: iconBg } as React.CSSProperties) : {};
  const labelId = controlId ? `${controlId}-label` : undefined;
  const descriptionId = controlId && value ? `${controlId}-description` : undefined;

  const indicator =
    trailing ??
    (isInteractive && !danger ? (
      external ? (
        <ExternalLink size={16} strokeWidth={2.25} aria-hidden="true" />
      ) : (
        <ChevronRight size={18} strokeWidth={2.25} aria-hidden="true" />
      )
    ) : null);

  const text = (
    <>
      <span id={labelId} className={styles.label}>
        {label}
        {external && <span className="sr-only"> (opens in a new tab)</span>}
      </span>
      {value && (
        <span id={descriptionId} className={styles.value}>
          {value}
        </span>
      )}
    </>
  );

  const body = (
    <>
      <span
        className={`${styles.iconBox} ${TONE_CLASS[danger ? 'red' : tone]}`}
        style={chipStyle}
        aria-hidden="true"
      >
        {icon}
      </span>
      {controlId ? (
        <label htmlFor={controlId} className={`${styles.content} ${styles.contentLabel}`}>
          {text}
        </label>
      ) : (
        <span className={styles.content}>{text}</span>
      )}
      {(indicator || !!badge) && (
        <span className={styles.trailing}>
          {!!badge && <span className={styles.badge}>{badge > 99 ? '99+' : badge}</span>}
          {indicator}
        </span>
      )}
    </>
  );

  const rowClass = [
    styles.row,
    children ? '' : styles.item,
    isInteractive ? styles.interactive : '',
    danger ? styles.danger : '',
  ]
    .filter(Boolean)
    .join(' ');

  let row: React.ReactNode;
  if (href) {
    row = (
      <a
        className={rowClass}
        href={href}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {body}
      </a>
    );
  } else if (onClick) {
    row = (
      <button type="button" className={rowClass} onClick={onClick}>
        {body}
      </button>
    );
  } else {
    row = <div className={rowClass}>{body}</div>;
  }

  if (!children) return row;

  return (
    <div className={styles.item}>
      {row}
      <div className={styles.extra}>{children}</div>
    </div>
  );
};
