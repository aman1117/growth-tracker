import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Text, type TextColor, type TextSize, type TextWeight } from './Text';
import styles from './Typography.module.css';

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

describe('Text', () => {
  it('renders a span with the body style by default', () => {
    render(<Text>Hello</Text>);
    const text = screen.getByText('Hello');

    expect(text.tagName).toBe('SPAN');
    expect(text).toHaveAttribute('class', styles.body);
  });

  it.each<TextSize>([
    'bodyLg',
    'body',
    'bodySm',
    'titleSm',
    'cardTitle',
    'label',
    'labelSm',
    'caption',
    'overline',
  ])('applies the %s role', (size) => {
    render(<Text size={size}>Role</Text>);
    expect(screen.getByText('Role')).toHaveClass(styles[size]);
  });

  it.each<TextColor>([
    'primary',
    'secondary',
    'tertiary',
    'muted',
    'inverse',
    'link',
    'success',
    'warning',
    'danger',
    'info',
  ])('applies the %s color', (color) => {
    render(<Text color={color}>Colored</Text>);
    expect(screen.getByText('Colored')).toHaveClass(styles[`color${capitalize(color)}`]);
  });

  it.each<TextWeight>(['normal', 'medium', 'semibold', 'bold'])(
    'applies the %s weight',
    (weight) => {
      render(<Text weight={weight}>Weighted</Text>);
      expect(screen.getByText('Weighted')).toHaveClass(styles[`weight${capitalize(weight)}`]);
    }
  );

  it.each(['left', 'center', 'right'] as const)('applies %s alignment', (align) => {
    render(<Text align={align}>Aligned</Text>);
    expect(screen.getByText('Aligned')).toHaveClass(styles[`align${capitalize(align)}`]);
  });

  it('truncates or clamps long text', () => {
    render(
      <>
        <Text truncate>One line</Text>
        <Text clamp={2}>Two lines</Text>
        <Text clamp={3}>Three lines</Text>
      </>
    );

    expect(screen.getByText('One line')).toHaveClass(styles.truncate);
    expect(screen.getByText('Two lines')).toHaveClass(styles.clamp2);
    expect(screen.getByText('Two lines')).not.toHaveClass(styles.clamp3);
    expect(screen.getByText('Three lines')).toHaveClass(styles.clamp3);
  });

  it.each(['p', 'div', 'time', 'small'] as const)('can render as a <%s>', (tag) => {
    render(
      <Text as={tag} className="extra">
        Tagged
      </Text>
    );
    const text = screen.getByText('Tagged');

    expect(text.tagName).toBe(tag.toUpperCase());
    expect(text).toHaveClass('extra');
  });

  it('renders an associated label', () => {
    render(
      <>
        <Text as="label" htmlFor="bio-input">
          Bio
        </Text>
        <input id="bio-input" />
      </>
    );
    expect(screen.getByLabelText('Bio')).toHaveAttribute('id', 'bio-input');
  });
});
