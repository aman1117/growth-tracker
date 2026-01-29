/**
 * Skeleton Component
 *
 * Loading placeholder with shimmer animation.
 * Uses design tokens for consistent styling.
 */

import React from 'react';

import styles from './Skeleton.module.css';

export interface SkeletonProps {
  /** Width of the skeleton (CSS value) */
  width?: string | number;
  /** Height of the skeleton (CSS value) */
  height?: string | number;
  /** Border radius variant */
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Whether to show shimmer animation */
  animate?: boolean;
  /** Glass variant for transparent backgrounds */
  glass?: boolean;
  /** Custom className */
  className?: string;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  width,
  height,
  radius = 'md',
  animate = true,
  glass = false,
  className = '',
}) => {
  const classNames = [
    styles.skeleton,
    styles[`radius-${radius}`],
    animate ? styles.animate : '',
    glass ? styles.glass : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const style: React.CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
  };

  return <div className={classNames} style={style} />;
};

/* Preset Skeleton Variants */

export interface SkeletonTextProps {
  /** Number of lines */
  lines?: number;
  /** Width of the last line (percentage) */
  lastLineWidth?: string;
  /** Custom className */
  className?: string;
}

export const SkeletonText: React.FC<SkeletonTextProps> = ({
  lines = 3,
  lastLineWidth = '70%',
  className = '',
}) => {
  return (
    <div className={`${styles.textContainer} ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={14}
          width={i === lines - 1 ? lastLineWidth : '100%'}
          radius="sm"
        />
      ))}
    </div>
  );
};

export interface SkeletonAvatarProps {
  /** Size variant */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Custom className */
  className?: string;
}

export const SkeletonAvatar: React.FC<SkeletonAvatarProps> = ({ size = 'md', className = '' }) => {
  const sizes = {
    sm: 32,
    md: 40,
    lg: 48,
    xl: 64,
  };

  return <Skeleton width={sizes[size]} height={sizes[size]} radius="full" className={className} />;
};

export interface SkeletonCardProps {
  /** Include avatar placeholder */
  avatar?: boolean;
  /** Number of text lines */
  lines?: number;
  /** Custom className */
  className?: string;
}

export const SkeletonCard: React.FC<SkeletonCardProps> = ({
  avatar = true,
  lines = 2,
  className = '',
}) => {
  return (
    <div className={`${styles.card} ${className}`}>
      {avatar && <SkeletonAvatar size="md" />}
      <div className={styles.cardContent}>
        <SkeletonText lines={lines} />
      </div>
    </div>
  );
};

export default Skeleton;
