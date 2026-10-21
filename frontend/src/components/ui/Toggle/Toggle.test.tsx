import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Toggle } from './Toggle';
import styles from './Toggle.module.css';

describe('Toggle', () => {
  it('is a switch named by its visible label and description', () => {
    render(
      <Toggle
        checked={false}
        onChange={vi.fn()}
        label="Private account"
        description="Only followers see your days"
      />
    );
    const toggle = screen.getByRole('switch', { name: /private account/i });

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAttribute('aria-disabled', 'false');
    expect(toggle).not.toHaveAttribute('aria-busy');
    expect(screen.getByText('Only followers see your days')).toHaveClass(styles.description);
  });

  it('reflects the checked state', () => {
    const { container } = render(<Toggle checked onChange={vi.fn()} aria-label="Dark mode" />);
    const toggle = screen.getByRole('switch', { name: 'Dark mode' });

    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveClass(styles.track, styles.checked);
    expect(container.querySelector('label')).not.toBeInTheDocument();
  });

  it.each([
    [false, true],
    [true, false],
  ])('calls onChange(%s → %s) when clicked', async (checked, next) => {
    const onChange = vi.fn();
    render(<Toggle checked={checked} onChange={onChange} aria-label="Sounds" />);

    await userEvent.click(screen.getByRole('switch', { name: 'Sounds' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(next);
  });

  it('toggles once per Enter or Space press', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} aria-label="Sounds" />);

    await user.tab();
    expect(screen.getByRole('switch', { name: 'Sounds' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(2);
    await user.keyboard('a');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it('toggles when its label is clicked', async () => {
    const onChange = vi.fn();
    render(<Toggle checked onChange={onChange} label="Reminders" />);

    await userEvent.click(screen.getByText('Reminders'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('ignores input when disabled', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Toggle checked={false} onChange={onChange} label="Push" disabled />
    );
    const toggle = screen.getByRole('switch', { name: 'Push' });

    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(container.firstElementChild).toHaveClass(styles.disabled);
    await userEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stays focusable but ignores input while busy', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <Toggle checked={false} onChange={onChange} aria-label="Sync" busy />
    );
    const toggle = screen.getByRole('switch', { name: 'Sync' });

    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute('aria-busy', 'true');
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(container.firstElementChild).toHaveClass(styles.busy);

    await user.click(toggle);
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('passes through id, size, class and ARIA relationships', () => {
    const { container } = render(
      <>
        <span id="row-title">Weekly digest</span>
        <span id="row-help">Sent every Monday</span>
        <Toggle
          checked={false}
          onChange={vi.fn()}
          id="digest-toggle"
          size="lg"
          className="row-toggle"
          aria-labelledby="row-title"
          aria-describedby="row-help"
        />
      </>
    );
    const toggle = screen.getByRole('switch', { name: 'Weekly digest' });

    expect(toggle).toHaveAttribute('id', 'digest-toggle');
    expect(toggle).toHaveAccessibleDescription('Sent every Monday');
    expect(container.querySelector(`.${styles.container}`)).toHaveClass(styles.lg, 'row-toggle');
  });

  it('defaults to the md size', () => {
    const { container } = render(<Toggle checked={false} onChange={vi.fn()} aria-label="x" />);
    expect(container.firstElementChild).toHaveClass(styles.md);
  });
});
