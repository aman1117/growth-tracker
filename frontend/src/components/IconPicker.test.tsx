import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ALL_ICONS, ICON_CATEGORIES } from '../constants/icons';
import IconPickerDefault, { IconPicker } from './IconPicker';
import styles from './IconPicker.module.css';

function renderPicker(props: Partial<ComponentProps<typeof IconPicker>> = {}) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const utils = render(<IconPicker value="Bike" onChange={onChange} {...props} />);
  return { ...utils, user, onChange };
}

const iconGrid = () => screen.getByRole('radiogroup', { name: 'Icons' });
const category = (name: string) => screen.getByRole('button', { name });

describe('IconPicker', () => {
  it('shows every category filter with "All" selected and every icon as a radio', () => {
    renderPicker();

    const filters = within(screen.getByRole('group', { name: 'Icon categories' }));
    expect(filters.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'All',
      ...Object.keys(ICON_CATEGORIES),
    ]);
    expect(category('All')).toHaveAttribute('aria-pressed', 'true');
    expect(within(iconGrid()).getAllByRole('radio')).toHaveLength(ALL_ICONS.length);
  });

  it('checks the current icon and labels icons in plain words', () => {
    renderPicker({ value: 'Gamepad2' });

    expect(screen.getByRole('radio', { name: 'Gamepad 2' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Gamepad 2' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Book open' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Pen tool' })).toHaveAttribute('tabindex', '-1');
  });

  it('calls onChange with the icon name when an icon is clicked', async () => {
    const { user, onChange } = renderPicker();

    await user.click(screen.getByRole('radio', { name: 'Message circle' }));

    expect(onChange).toHaveBeenCalledWith('MessageCircle');
  });

  it('filters the grid by category', async () => {
    const { user } = renderPicker();

    await user.click(category('Work'));

    expect(category('Work')).toHaveAttribute('aria-pressed', 'true');
    expect(category('All')).toHaveAttribute('aria-pressed', 'false');
    expect(within(iconGrid()).getAllByRole('radio')).toHaveLength(ICON_CATEGORIES.Work.length);
    expect(screen.getByRole('radio', { name: 'Briefcase' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Bike' })).not.toBeInTheDocument();
  });

  it('keeps the first icon tabbable when the current icon is filtered out', async () => {
    const { user } = renderPicker({ value: 'Bike' });

    await user.click(category('Travel'));

    expect(screen.queryByRole('radio', { checked: true })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Plane' })).toHaveAttribute('tabindex', '0');
  });

  it('moves focus and selection with the keyboard', async () => {
    const { user, onChange } = renderPicker({ value: 'Bike' });
    screen.getByRole('radio', { name: 'Bike' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Dumbbell' })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('Dumbbell');

    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith(ALL_ICONS[ALL_ICONS.length - 1]);
  });

  it('picks a check mark that contrasts with the tile color', () => {
    const { unmount } = renderPicker({ value: 'Bike', color: '#fde047' });
    const brightCheck = screen.getByRole('radio', { name: 'Bike' }).querySelector('span');
    expect(brightCheck).toHaveClass(styles.checkBadgeDark);
    unmount();

    renderPicker({ value: 'Bike', color: '#1e1b4b' });
    const deepCheck = screen.getByRole('radio', { name: 'Bike' }).querySelector('span');
    expect(deepCheck).toHaveClass(styles.checkBadge);
    expect(deepCheck).not.toHaveClass(styles.checkBadgeDark);
  });

  it('assumes a deep color when the tile color is a CSS variable', () => {
    renderPicker({ value: 'Bike' });

    const check = screen.getByRole('radio', { name: 'Bike' }).querySelector('span');
    expect(check).not.toHaveClass(styles.checkBadgeDark);
  });

  it('is exported as the default export', () => {
    expect(IconPickerDefault).toBe(IconPicker);
  });
});
