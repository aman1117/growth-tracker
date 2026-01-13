/**
 * Toggle Component
 *
 * Switch component for boolean settings.
 * Uses design tokens for consistent styling.
 */

import React from 'react';
import styles from './Toggle.module.css';

export interface ToggleProps {
  /** Whether the toggle is on */
  checked: boolean;
  /** Callback when toggle state changes */
  onChange: (checked: boolean) => void;
  /** Label text */
  label?: string;
  /** Description text */
  description?: string;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Disabled state */
  disabled?: boolean;
  /** ID for accessibility */
  id?: string;
  /** Custom className */
  className?: string;
}

export const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  label,
  description,
  size = 'md',
  disabled = false,
  id,
  className = '',
}) => {
  const toggleId = id || `toggle-${Math.random().toString(36).slice(2, 9)}`;

  const containerClasses = [
    styles.container,
    styles[size],
    disabled ? styles.disabled : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const trackClasses = [
    styles.track,
    checked ? styles.checked : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick = () => {
    if (!disabled) {
      onChange(!checked);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div className={containerClasses}>
      <button
        id={toggleId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        className={trackClasses}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      >
        <span className={styles.thumb} />
      </button>
      {(label || description) && (
        <label htmlFor={toggleId} className={styles.labelContainer}>
          {label && <span className={styles.label}>{label}</span>}
          {description && <span className={styles.description}>{description}</span>}
        </label>
      )}
    </div>
  );
};

export default Toggle;
