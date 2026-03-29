/**
 * Heading Component
 *
 * Semantic heading component that maps heading levels to typography roles.
 * Ensures proper heading hierarchy (h1–h6) with consistent visual styling.
 *
 * @example
 * <Heading level={1}>Page Title</Heading>
 * <Heading level={2} size="cardTitle">Small Section</Heading>
 * <Heading level={3} color="secondary">Muted heading</Heading>
 */

import React from 'react';

import styles from './Typography.module.css';

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type HeadingSize = 'display' | 'pageTitle' | 'sectionTitle' | 'cardTitle' | 'titleSm';

export type HeadingColor = 'primary' | 'secondary' | 'tertiary' | 'muted' | 'inverse';

export interface HeadingProps {
  /** Semantic heading level (h1–h6) */
  level: HeadingLevel;
  /** Visual size — defaults based on level if not set */
  size?: HeadingSize;
  /** Text color */
  color?: HeadingColor;
  /** Additional className */
  className?: string;
  children: React.ReactNode;
}

const defaultSizeForLevel: Record<HeadingLevel, HeadingSize> = {
  1: 'pageTitle',
  2: 'sectionTitle',
  3: 'cardTitle',
  4: 'titleSm',
  5: 'titleSm',
  6: 'titleSm',
};

const colorMap: Record<HeadingColor, string> = {
  primary: styles.colorPrimary,
  secondary: styles.colorSecondary,
  tertiary: styles.colorTertiary,
  muted: styles.colorMuted,
  inverse: styles.colorInverse,
};

export const Heading: React.FC<HeadingProps> = ({ level, size, color, className, children }) => {
  const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  const sizeClass = styles[size ?? defaultSizeForLevel[level]];

  const classes = [sizeClass, color && colorMap[color], className].filter(Boolean).join(' ');

  return <Tag className={classes}>{children}</Tag>;
};
