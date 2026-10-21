import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IconButton, type IconButtonSize, type IconButtonVariant } from './IconButton';
import styles from './IconButton.module.css';

const Icon = () => <svg data-icon="settings" />;

describe('IconButton', () => {
  it('renders the icon with an accessible name and default styling', () => {
    render(<IconButton icon={<Icon />} aria-label="Settings" />);
    const button = screen.getByRole('button', { name: 'Settings' });

    expect(button).toHaveClass(styles.iconButton, styles.default, styles.md);
    expect(button.querySelector('[data-icon="settings"]')).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it.each<IconButtonVariant>(['default', 'ghost', 'glass', 'danger'])(
    'applies the %s variant',
    (variant) => {
      render(<IconButton icon={<Icon />} aria-label="Act" variant={variant} />);
      expect(screen.getByRole('button', { name: 'Act' })).toHaveClass(styles[variant]);
    }
  );

  it.each<IconButtonSize>(['xs', 'sm', 'md', 'lg'])('applies the %s size', (size) => {
    render(<IconButton icon={<Icon />} aria-label="Act" size={size} className="extra" />);
    expect(screen.getByRole('button', { name: 'Act' })).toHaveClass(styles[size], 'extra');
  });

  it('calls onClick from mouse and keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton icon={<Icon />} aria-label="Close" onClick={onClick} />);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('replaces the icon with a spinner and disables itself while loading', async () => {
    const onClick = vi.fn();
    render(<IconButton icon={<Icon />} aria-label="Sync" loading onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Sync' });

    expect(button).toBeDisabled();
    expect(button).toHaveClass(styles.loading);
    expect(button.querySelector(`.${styles.spinner}`)).toBeInTheDocument();
    expect(button.querySelector('[data-icon="settings"]')).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('can be disabled', () => {
    render(<IconButton icon={<Icon />} aria-label="Delete" disabled />);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });
});
