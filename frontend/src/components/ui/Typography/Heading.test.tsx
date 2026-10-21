import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Heading, type HeadingLevel, type HeadingSize } from './Heading';
import styles from './Typography.module.css';

describe('Heading', () => {
  it.each<[HeadingLevel, HeadingSize]>([
    [1, 'pageTitle'],
    [2, 'sectionTitle'],
    [3, 'cardTitle'],
    [4, 'titleSm'],
    [5, 'titleSm'],
    [6, 'titleSm'],
  ])('renders an h%i with the %s style by default', (level, size) => {
    render(<Heading level={level}>Title</Heading>);
    expect(screen.getByRole('heading', { level, name: 'Title' })).toHaveAttribute(
      'class',
      styles[size]
    );
  });

  it('lets the visual size differ from the semantic level', () => {
    render(
      <Heading level={2} size="display">
        Big
      </Heading>
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Big' })).toHaveClass(styles.display);
  });

  it.each([
    ['primary', 'colorPrimary'],
    ['secondary', 'colorSecondary'],
    ['tertiary', 'colorTertiary'],
    ['muted', 'colorMuted'],
    ['inverse', 'colorInverse'],
  ] as const)('applies the %s color', (color, className) => {
    render(
      <Heading level={3} color={color} className="extra">
        Colored
      </Heading>
    );
    expect(screen.getByRole('heading', { name: 'Colored' })).toHaveClass(
      styles.cardTitle,
      styles[className],
      'extra'
    );
  });
});
