/**
 * Input Component
 *
 * Reusable form input with label and error state.
 */

import type { InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef, useId } from 'react';

import styles from './Input.module.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Input label */
  label?: string;
  /** Error message */
  error?: string;
  /** Helper text */
  helperText?: string;
  /** Icon to show on the left */
  icon?: ReactNode;
  /** Icon to show on the right */
  iconRight?: ReactNode;
  /** Full width input */
  fullWidth?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      helperText,
      icon,
      iconRight,
      fullWidth = true,
      className = '',
      id,
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref
  ) => {
    const autoId = useId();
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-') || autoId;
    const messageId = `${inputId}-message`;
    const hasMessage = !!error || !!helperText;
    const describedBy =
      [ariaDescribedBy, hasMessage ? messageId : null].filter(Boolean).join(' ') || undefined;

    return (
      <div className={`${styles.wrapper} ${fullWidth ? styles.fullWidth : ''} ${className}`}>
        {label && (
          <label htmlFor={inputId} className={styles.label}>
            {label}
          </label>
        )}
        <div className={`${styles.inputWrapper} ${error ? styles.hasError : ''}`}>
          {icon && <span className={styles.icon}>{icon}</span>}
          <input
            ref={ref}
            id={inputId}
            className={styles.input}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            {...props}
          />
          {iconRight && <span className={styles.iconRight}>{iconRight}</span>}
        </div>
        {error && (
          <span id={messageId} className={styles.error} role="alert">
            {error}
          </span>
        )}
        {helperText && !error && (
          <span id={messageId} className={styles.helper}>
            {helperText}
          </span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export default Input;
