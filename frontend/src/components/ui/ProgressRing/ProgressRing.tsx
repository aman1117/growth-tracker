/**
 * ProgressRing Component
 *
 * Circular progress indicator with optional centered content (e.g. "5/21").
 * Exposed as a progressbar: screen readers hear `label` and `valueText`
 * (the ring and the centered content are presentational).
 */

import React from 'react';

import styles from './ProgressRing.module.css';

export interface ProgressRingProps {
  /** Progress so far (clamped to 0..max) */
  value: number;
  /** Value of a full ring; 0 or less renders an empty ring */
  max: number;
  /** Accessible name, e.g. "Days met" */
  label: string;
  /** Accessible value, e.g. "5 of 21 days" (defaults to the percentage) */
  valueText?: string;
  /** Diameter in px */
  size?: number;
  /** Ring thickness in px */
  strokeWidth?: number;
  /** Ring color (any CSS color, e.g. an activity color); defaults to the accent */
  color?: string;
  /** Centered content (visual only — describe it in `valueText`) */
  children?: React.ReactNode;
  className?: string;
}

/** Share of the ring to fill, 0..1 */
const getRatio = (value: number, max: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
};

export const ProgressRing: React.FC<ProgressRingProps> = ({
  value,
  max,
  label,
  valueText,
  size = 96,
  strokeWidth = 8,
  color,
  children,
  className = '',
}) => {
  const ratio = getRatio(value, max);
  const percent = Math.round(ratio * 100);
  const radius = Math.max(0, (size - strokeWidth) / 2);
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  const style = {
    width: size,
    height: size,
    ...(color ? { '--progress-ring-color': color } : {}),
  } as React.CSSProperties;

  return (
    <div
      className={`${styles.ring} ${className}`.trim()}
      style={style}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText ?? `${percent}%`}
    >
      <svg
        className={styles.svg}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        focusable="false"
      >
        <circle
          className={styles.track}
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={strokeWidth}
        />
        <circle
          className={styles.indicator}
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          opacity={ratio > 0 ? 1 : 0}
        />
      </svg>
      {children !== undefined && children !== null && (
        <div className={styles.content} aria-hidden="true">
          {children}
        </div>
      )}
    </div>
  );
};

export default ProgressRing;
