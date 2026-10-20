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
  /**
   * A change is being saved: ignores input but stays focusable, so keyboard focus
   * isn't lost the way it is when a focused button becomes `disabled`
   */
  busy?: boolean;
  /** ID for accessibility */
  id?: string;
  /** Accessible name when no visible `label` is rendered */
  'aria-label'?: string;
  /** ID of an element that names the switch (e.g. a settings row title) */
  'aria-labelledby'?: string;
  /** ID of an element that describes the switch */
  'aria-describedby'?: string;
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
  busy = false,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  className = '',
}) => {
  const generatedId = React.useId();
  const toggleId = id || generatedId;

  const containerClasses = [
    styles.container,
    styles[size],
    disabled ? styles.disabled : '',
    busy ? styles.busy : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const trackClasses = [styles.track, checked ? styles.checked : ''].filter(Boolean).join(' ');

  const handleClick = () => {
    if (!disabled && !busy) {
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
        aria-disabled={disabled || busy}
        aria-busy={busy || undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
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
