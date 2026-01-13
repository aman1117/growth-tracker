/**
 * EmptyState Component
 *
 * Consistent empty state display with icon, title, description, and optional action.
 * Uses design tokens for consistent styling.
 */

import React from 'react';
import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';
import { Button } from '../Button';
import type { ButtonProps } from '../Button';

export interface EmptyStateProps {
  /** Icon to display */
  icon?: ReactNode;
  /** Main title text */
  title: string;
  /** Description text */
  description?: string;
  /** Action button props */
  action?: {
    label: string;
    onClick: () => void;
  } & Partial<Pick<ButtonProps, 'variant' | 'icon'>>;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Custom className */
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  size = 'md',
  className = '',
}) => {
  const classNames = [
    styles.emptyState,
    styles[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classNames}>
      {icon && <div className={styles.icon}>{icon}</div>}
      <h3 className={styles.title}>{title}</h3>
      {description && <p className={styles.description}>{description}</p>}
      {action && (
        <Button
          variant={action.variant || 'primary'}
          size={size === 'sm' ? 'sm' : 'md'}
          onClick={action.onClick}
          icon={action.icon}
          className={styles.action}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
};

export default EmptyState;
