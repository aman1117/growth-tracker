import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BrandLogo, type BrandLogoSize } from './BrandLogo';
import styles from './BrandLogo.module.css';

const svgOf = (container: HTMLElement) => container.querySelector('svg') as SVGSVGElement;

describe('BrandLogo', () => {
  it('renders the full lockup named after the app by default', () => {
    const { container } = render(<BrandLogo />);
    const logo = screen.getByRole('img', { name: 'Growth Tracker' });

    expect(logo).toBe(svgOf(container));
    expect(logo).toHaveAttribute('viewBox', '0 0 1368.69 225');
    expect(logo).toHaveClass(styles.logo, styles.md);
    expect(logo).not.toHaveClass(styles.icon);
    expect(logo).not.toHaveClass(styles.animated);
    expect(logo.style.aspectRatio).toBe('1368.69 / 225');
    // Two leaves plus the wordmark, no app-icon tile
    expect(logo.querySelectorAll('path')).toHaveLength(3);
    expect(logo.querySelector(`.${styles.wordmark}`)).toBeInTheDocument();
    expect(logo.querySelector('rect')).not.toBeInTheDocument();
  });

  it('renders only the leaf mark for the mark variant', () => {
    const logo = svgOf(render(<BrandLogo variant="mark" />).container);

    expect(logo).toHaveAttribute('viewBox', '0 0 110.19 100');
    expect(logo.style.aspectRatio).toBe('110.19 / 100');
    expect(logo.querySelectorAll('path')).toHaveLength(2);
    expect(logo.querySelector(`.${styles.leafShort}`)).toBeInTheDocument();
    expect(logo.querySelector(`.${styles.leafLong}`)).toBeInTheDocument();
    expect(logo.querySelector(`.${styles.wordmark}`)).not.toBeInTheDocument();
  });

  it('renders the leaves on a rounded tile for the icon variant', () => {
    const logo = svgOf(render(<BrandLogo variant="icon" />).container);
    const tile = logo.querySelector('rect');

    expect(logo).toHaveAttribute('viewBox', '0 0 100 100');
    expect(logo).toHaveClass(styles.icon);
    expect(logo.style.aspectRatio).toBe('1 / 1');
    expect(tile).toHaveAttribute('rx', '23');
    expect(tile).toHaveClass(styles.tile);
    expect(logo.querySelectorAll('path')).toHaveLength(2);
  });

  it.each<BrandLogoSize>(['sm', 'md', 'lg', 'xl'])('applies the %s size', (size) => {
    expect(svgOf(render(<BrandLogo size={size} />).container)).toHaveClass(styles[size]);
  });

  it('plays the sprout animation when animated and keeps custom classes', () => {
    const logo = svgOf(render(<BrandLogo animated className="hero-logo" />).container);
    expect(logo).toHaveClass(styles.animated, 'hero-logo');
  });

  it('uses a custom accessible name', () => {
    render(<BrandLogo label="Go to home" />);
    expect(screen.getByRole('img', { name: 'Go to home' })).toBeInTheDocument();
  });

  it('is hidden from assistive technology when the label is empty', () => {
    const logo = svgOf(render(<BrandLogo label="" />).container);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(logo).toHaveAttribute('aria-hidden', 'true');
    expect(logo).toHaveAttribute('focusable', 'false');
    expect(logo).not.toHaveAttribute('aria-label');
  });
});
