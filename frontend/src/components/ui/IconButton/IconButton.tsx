/**
 * IconButton Component
 *
 * A circular button for icon-only actions.
 * Uses design tokens for consistent styling.
 */

import React from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './IconButton.module.css';

export type IconButtonVariant = 'default' | 'ghost' | 'glass' | 'danger';
export type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Button variant */
  variant?: IconButtonVariant;
  /** Button size */
  size?: IconButtonSize;
  /** Icon element */
  icon: ReactNode;
  /** Loading state */
  loading?: boolean;
  /** Accessible label */
  'aria-label': string;
}

export const IconButton: React.FC<IconButtonProps> = ({
  variant = 'default',
  size = 'md',
  icon,
  loading = false,
  disabled,
  className = '',
  ...props
}) => {
  const classNames = [
    styles.iconButton,
    styles[variant],
    styles[size],
    loading ? styles.loading : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={classNames}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <span className={styles.spinner} /> : icon}
    </button>
  );
};

export default IconButton;
