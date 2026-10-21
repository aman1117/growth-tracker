import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LoadingSpinner, type SpinnerSize } from './LoadingSpinner';
import styles from './LoadingSpinner.module.css';

describe('LoadingSpinner', () => {
  it('renders a presentational medium spinner by default', () => {
    render(<LoadingSpinner />);
    const spinner = screen.getByRole('presentation');

    expect(spinner).toHaveClass(styles.spinner, styles.md);
    expect(spinner).not.toHaveClass(styles.center);
    expect(spinner.firstElementChild).toHaveClass(styles.circle);
  });

  it.each<SpinnerSize>(['sm', 'md', 'lg'])('applies the %s size', (size) => {
    render(<LoadingSpinner size={size} />);
    expect(screen.getByRole('presentation')).toHaveClass(styles[size]);
  });

  it('can be centered and accept a custom class', () => {
    render(<LoadingSpinner center className="page-loader" />);
    expect(screen.getByRole('presentation')).toHaveClass(styles.center, 'page-loader');
  });
});
