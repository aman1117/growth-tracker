/**
 * BrandLogo Component
 *
 * The "Growth Tracker" script wordmark painted with the aurora brand gradient.
 * The PNG is used as a CSS mask, so the logo adapts to light/dark mode through
 * tokens alone (no image swaps or color filters).
 *
 * @example
 * <BrandLogo />                 // header size
 * <BrandLogo size="lg" animated /> // hero / auth screens
 */

import type { FC } from 'react';

import { APP_NAME } from '../../../utils/navigation';
import styles from './BrandLogo.module.css';

export type BrandLogoSize = 'sm' | 'md' | 'lg';

export interface BrandLogoProps {
  /** Visual size preset (height of the wordmark) */
  size?: BrandLogoSize;
  /** Slowly drifts the gradient (disabled automatically for reduced motion) */
  animated?: boolean;
  /** Additional CSS class */
  className?: string;
  /**
   * Accessible name. Pass an empty string when the logo sits inside a control
   * that already provides a label (e.g. a "home" button).
   */
  label?: string;
}

export const BrandLogo: FC<BrandLogoProps> = ({
  size = 'md',
  animated = false,
  className,
  label = APP_NAME,
}) => {
  const classNames = [styles.logo, styles[size], animated && styles.animated, className]
    .filter(Boolean)
    .join(' ');

  return label ? (
    <span className={classNames} role="img" aria-label={label} />
  ) : (
    <span className={classNames} aria-hidden="true" />
  );
};

export default BrandLogo;
