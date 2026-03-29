/**
 * Text Component
 *
 * Semantic text component that maps typography roles to design tokens.
 * Enforces consistent font-size, weight, line-height, and letter-spacing.
 *
 * @example
 * <Text size="body">Default body text</Text>
 * <Text size="titleSm" color="secondary">Small title in secondary color</Text>
 * <Text size="caption" color="muted" truncate>Truncated caption</Text>
 */

import React from 'react';

import styles from './Typography.module.css';

export type TextSize =
  | 'bodyLg'
  | 'body'
  | 'bodySm'
  | 'titleSm'
  | 'cardTitle'
  | 'label'
  | 'labelSm'
  | 'caption'
  | 'overline';

export type TextColor =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'muted'
  | 'inverse'
  | 'link'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

export type TextWeight = 'normal' | 'medium' | 'semibold' | 'bold';

export type TextAlign = 'left' | 'center' | 'right';

export interface TextProps {
  /** The text role — determines size, weight, line-height, and letter-spacing */
  size?: TextSize;
  /** Semantic text color */
  color?: TextColor;
  /** Override the default weight for this role */
  weight?: TextWeight;
  /** Text alignment */
  align?: TextAlign;
  /** Truncate with ellipsis */
  truncate?: boolean;
  /** Clamp to N lines */
  clamp?: 2 | 3;
  /** HTML element to render */
  as?: 'p' | 'span' | 'div' | 'label' | 'time' | 'small';
  /** Additional className */
  className?: string;
  /** For label elements */
  htmlFor?: string;
  children: React.ReactNode;
}

const colorMap: Record<TextColor, string> = {
  primary: styles.colorPrimary,
  secondary: styles.colorSecondary,
  tertiary: styles.colorTertiary,
  muted: styles.colorMuted,
  inverse: styles.colorInverse,
  link: styles.colorLink,
  success: styles.colorSuccess,
  warning: styles.colorWarning,
  danger: styles.colorDanger,
  info: styles.colorInfo,
};

const weightMap: Record<TextWeight, string> = {
  normal: styles.weightNormal,
  medium: styles.weightMedium,
  semibold: styles.weightSemibold,
  bold: styles.weightBold,
};

const alignMap: Record<TextAlign, string> = {
  left: styles.alignLeft,
  center: styles.alignCenter,
  right: styles.alignRight,
};

export const Text: React.FC<TextProps> = ({
  size = 'body',
  color,
  weight,
  align,
  truncate,
  clamp,
  as: Tag = 'span',
  className,
  htmlFor,
  children,
}) => {
  const classes = [
    styles[size],
    color && colorMap[color],
    weight && weightMap[weight],
    align && alignMap[align],
    truncate && styles.truncate,
    clamp === 2 && styles.clamp2,
    clamp === 3 && styles.clamp3,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={classes} htmlFor={htmlFor}>
      {children}
    </Tag>
  );
};
