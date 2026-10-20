/**
 * BrandLogo Component
 *
 * The Growth Tracker logo: a "leaf check" mark (two leaves that form a check —
 * growth you can track) next to the wordmark. Everything is drawn as inline SVG
 * from `brandGeometry.json`, the same geometry `npm run brand:assets` uses for the
 * favicon and app icons, so every surface matches. Fills are solid brand tokens
 * (no gradients) that adapt to light and dark mode.
 *
 * @example
 * <BrandLogo />                                  // header lockup
 * <BrandLogo variant="mark" size="sm" />         // symbol only
 * <BrandLogo variant="icon" size="xl" animated /> // app-icon tile (auth hero)
 */

import type { CSSProperties, FC } from 'react';

import { APP_NAME } from '../../../utils/navigation';
import geometry from './brandGeometry.json';
import styles from './BrandLogo.module.css';

export type BrandLogoSize = 'sm' | 'md' | 'lg' | 'xl';
export type BrandLogoVariant = 'lockup' | 'mark' | 'icon';

export interface BrandLogoProps {
  /** Visual size preset (height of the logo) */
  size?: BrandLogoSize;
  /** `lockup` (mark + wordmark), `mark` (symbol only) or `icon` (app-icon tile) */
  variant?: BrandLogoVariant;
  /** Plays a one-time sprout animation (skipped for reduced motion) */
  animated?: boolean;
  /** Additional CSS class */
  className?: string;
  /**
   * Accessible name. Pass an empty string when the logo sits inside a control
   * that already provides a label (e.g. a "home" button).
   */
  label?: string;
}

const { mark, wordmark, lockup, icon } = geometry;

const VIEW_BOX: Record<BrandLogoVariant, string> = {
  lockup: `0 0 ${lockup.width} ${lockup.height}`,
  mark: `0 0 ${mark.width} ${mark.height}`,
  icon: `0 0 ${icon.size} ${icon.size}`,
};

const ASPECT_RATIO: Record<BrandLogoVariant, string> = {
  lockup: `${lockup.width} / ${lockup.height}`,
  mark: `${mark.width} / ${mark.height}`,
  icon: '1 / 1',
};

/** Transform origin of the sprout animation: the leaves' shared base, as % of the mark box */
const SPROUT_ORIGIN = `${((mark.base[0] / mark.width) * 100).toFixed(1)}% ${((mark.base[1] / mark.height) * 100).toFixed(1)}%`;

const placement = (p: { x: number; y: number; scale: number }) =>
  `translate(${p.x} ${p.y}) scale(${p.scale})`;

const Leaves: FC = () => (
  <g className={styles.leaves} style={{ transformOrigin: SPROUT_ORIGIN }}>
    <path className={styles.leafShort} d={mark.leafShort} />
    <path className={styles.leafLong} d={mark.leafLong} />
  </g>
);

export const BrandLogo: FC<BrandLogoProps> = ({
  size = 'md',
  variant = 'lockup',
  animated = false,
  className,
  label = APP_NAME,
}) => {
  const classNames = [
    styles.logo,
    styles[size],
    variant === 'icon' && styles.icon,
    animated && styles.animated,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const a11y = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true, focusable: false } as const);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={VIEW_BOX[variant]}
      className={classNames}
      style={{ aspectRatio: ASPECT_RATIO[variant] } as CSSProperties}
      {...a11y}
    >
      {variant === 'mark' && <Leaves />}

      {variant === 'icon' && (
        <>
          <rect
            className={styles.tile}
            width={icon.size}
            height={icon.size}
            rx={icon.radius}
            ry={icon.radius}
          />
          <g transform={placement(icon.mark)}>
            <Leaves />
          </g>
        </>
      )}

      {variant === 'lockup' && (
        <>
          <g transform={placement(lockup.mark)}>
            <Leaves />
          </g>
          <path
            className={styles.wordmark}
            transform={`translate(${lockup.wordmark.x} ${lockup.wordmark.y})`}
            d={wordmark.path}
          />
        </>
      )}
    </svg>
  );
};

export default BrandLogo;
