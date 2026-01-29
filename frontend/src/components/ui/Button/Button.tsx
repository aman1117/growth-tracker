/**
 * Button Component
 *
 * Reusable button with variants, sizes, and loading state.
 * Uses design tokens for consistent styling across the app.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import React from 'react';

import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline' | 'glass';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Button variant */
  variant?: ButtonVariant;
  /** Button size */
  size?: ButtonSize;
  /** Loading state */
  loading?: boolean;
  /** Full width button */
  fullWidth?: boolean;
  /** Icon to show before text */
  icon?: ReactNode;
  /** Icon to show after text */
  iconRight?: ReactNode;
  /** Icon only mode (no text, square button) */
  iconOnly?: boolean;
  /** Hover label - shows different text on hover (useful for Following -> Unfollow) */
  hoverLabel?: ReactNode;
  /** Hover variant - changes variant on hover */
  hoverVariant?: ButtonVariant;
  /** Children content */
  children: ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  icon,
  iconRight,
  iconOnly = false,
  hoverLabel,
  hoverVariant,
  children,
  disabled,
  className = '',
  ...props
}) => {
  const classNames = [
    styles.button,
    styles[variant],
    styles[size],
    fullWidth ? styles.fullWidth : '',
    loading ? styles.loading : '',
    iconOnly ? styles.iconOnly : '',
    hoverLabel ? styles.hasHoverLabel : '',
    hoverVariant
      ? styles[`hover${hoverVariant.charAt(0).toUpperCase() + hoverVariant.slice(1)}`]
      : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classNames} disabled={disabled || loading} {...props}>
      {loading && <span className={styles.spinner} />}
      {!loading && icon && <span className={styles.icon}>{icon}</span>}
      {!iconOnly && (
        <>
          <span className={styles.text}>{children}</span>
          {hoverLabel && <span className={styles.hoverText}>{hoverLabel}</span>}
        </>
      )}
      {!loading && iconRight && <span className={styles.iconRight}>{iconRight}</span>}
    </button>
  );
};

export default Button;
