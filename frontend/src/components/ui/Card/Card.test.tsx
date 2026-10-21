import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Card } from './Card';
import styles from './Card.module.css';

describe('Card', () => {
  it('renders children with the default variant and medium padding', () => {
    render(<Card>Weekly summary</Card>);
    const card = screen.getByText('Weekly summary');

    expect(card).toHaveClass(styles.card, styles.default, styles['padding-md']);
    expect(card).not.toHaveClass(styles.interactive);
  });

  it('supports the glass variant, padding presets and interactive hover', () => {
    render(
      <Card variant="glass" padding="lg" interactive className="stats">
        Glass
      </Card>
    );

    expect(screen.getByText('Glass')).toHaveClass(
      styles.glass,
      styles['padding-lg'],
      styles.interactive,
      'stats'
    );
  });

  it.each(['none', 'sm', 'md', 'lg'] as const)('applies the %s padding', (padding) => {
    render(<Card padding={padding}>Body</Card>);
    expect(screen.getByText('Body')).toHaveClass(styles[`padding-${padding}`]);
  });

  it('forwards native attributes and handlers', async () => {
    const onClick = vi.fn();
    render(
      <Card role="region" aria-label="Streak" onClick={onClick}>
        7 days
      </Card>
    );

    await userEvent.click(screen.getByRole('region', { name: 'Streak' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
