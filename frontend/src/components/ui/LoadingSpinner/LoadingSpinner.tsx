/**
 * LoadingSpinner Component
 *
 * Reusable loading indicator.
 */

import React from 'react';
import styles from './LoadingSpinner.module.css';

export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface LoadingSpinnerProps {
  /** Spinner size */
  size?: SpinnerSize;
  /** Center spinner in container */
  center?: boolean;
  /** Custom className */
  className?: string;
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  size = 'md',
  center = false,
  className = '',
}) => {
  const classNames = [
    styles.spinner,
    styles[size],
    center ? styles.center : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classNames}>
      <div className={styles.circle} />
    </div>
  );
};

export default LoadingSpinner;
