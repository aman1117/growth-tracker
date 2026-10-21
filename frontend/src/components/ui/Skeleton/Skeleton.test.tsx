import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Skeleton, SkeletonAvatar, SkeletonCard, SkeletonText } from './Skeleton';
import styles from './Skeleton.module.css';

const skeletonsIn = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(`.${styles.skeleton}`));

describe('Skeleton', () => {
  it('renders an animated placeholder with medium radius by default', () => {
    const [skeleton] = skeletonsIn(render(<Skeleton />).container);

    expect(skeleton).toHaveClass(styles['radius-md'], styles.animate);
    expect(skeleton).not.toHaveClass(styles.glass);
    expect(skeleton.getAttribute('style') ?? '').toBe('');
  });

  it('converts numeric sizes to pixels and keeps CSS strings', () => {
    const [px] = skeletonsIn(render(<Skeleton width={40} height={12} />).container);
    const [css] = skeletonsIn(render(<Skeleton width="50%" height="2rem" />).container);

    expect(px).toHaveStyle({ width: '40px', height: '12px' });
    expect(css).toHaveStyle({ width: '50%', height: '2rem' });
  });

  it.each(['none', 'sm', 'md', 'lg', 'xl', 'full'] as const)('applies the %s radius', (radius) => {
    const [skeleton] = skeletonsIn(render(<Skeleton radius={radius} />).container);
    expect(skeleton).toHaveClass(styles[`radius-${radius}`]);
  });

  it('can disable the shimmer, use the glass style and add a class', () => {
    const [skeleton] = skeletonsIn(
      render(<Skeleton animate={false} glass className="row" />).container
    );

    expect(skeleton).not.toHaveClass(styles.animate);
    expect(skeleton).toHaveClass(styles.glass, 'row');
  });
});

describe('SkeletonText', () => {
  it('renders three lines with a shorter last line by default', () => {
    const { container } = render(<SkeletonText className="bio" />);
    const lines = skeletonsIn(container);

    expect(container.firstElementChild).toHaveClass(styles.textContainer, 'bio');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveStyle({ width: '100%', height: '14px' });
    expect(lines[1]).toHaveStyle({ width: '100%' });
    expect(lines[2]).toHaveStyle({ width: '70%' });
    lines.forEach((line) => expect(line).toHaveClass(styles['radius-sm']));
  });

  it('supports a custom line count and last-line width', () => {
    const lines = skeletonsIn(render(<SkeletonText lines={2} lastLineWidth="40%" />).container);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toHaveStyle({ width: '40%' });
  });
});

describe('SkeletonAvatar', () => {
  it.each([
    ['sm', '32px'],
    ['md', '40px'],
    ['lg', '48px'],
    ['xl', '64px'],
  ] as const)('renders a round %s avatar of %s', (size, px) => {
    const [avatar] = skeletonsIn(render(<SkeletonAvatar size={size} className="me" />).container);

    expect(avatar).toHaveStyle({ width: px, height: px });
    expect(avatar).toHaveClass(styles['radius-full'], 'me');
  });

  it('defaults to the md size', () => {
    const [avatar] = skeletonsIn(render(<SkeletonAvatar />).container);
    expect(avatar).toHaveStyle({ width: '40px' });
  });
});

describe('SkeletonCard', () => {
  it('renders an avatar and two text lines by default', () => {
    const { container } = render(<SkeletonCard className="feed" />);
    const parts = skeletonsIn(container);

    expect(container.firstElementChild).toHaveClass(styles.card, 'feed');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveClass(styles['radius-full']);
  });

  it('can omit the avatar and change the line count', () => {
    const parts = skeletonsIn(render(<SkeletonCard avatar={false} lines={4} />).container);

    expect(parts).toHaveLength(4);
    parts.forEach((part) => expect(part).not.toHaveClass(styles['radius-full']));
  });
});
