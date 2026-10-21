import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ThemePickerProps } from '../SettingsPage.types';
import { ThemePicker } from './ThemePicker';

function renderPicker(value: ThemePickerProps['value'] = 'light') {
  const onChange = vi.fn();
  render(<ThemePicker value={value} onChange={onChange} />);
  return { user: userEvent.setup(), onChange };
}

const radio = (name: string | RegExp) => screen.getByRole('radio', { name });

describe('ThemePicker', () => {
  it('is a radio group with light, dark and automatic options', () => {
    renderPicker('dark');

    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((option) => option.textContent)).toEqual([
      'Light',
      'Dark',
      'Auto, matches your device',
    ]);
    expect(radio('Dark')).toBeChecked();
    expect(radio('Light')).not.toBeChecked();
  });

  it('keeps a single tab stop on the selected option', () => {
    renderPicker('system');

    expect(radio(/Auto/)).toHaveAttribute('tabindex', '0');
    expect(radio('Light')).toHaveAttribute('tabindex', '-1');
    expect(radio('Dark')).toHaveAttribute('tabindex', '-1');
  });

  it('selects a theme on click', async () => {
    const { user, onChange } = renderPicker('light');

    await user.click(radio(/Auto/));

    expect(onChange).toHaveBeenCalledWith('system');
  });

  it('moves focus and selection with the arrow, Home and End keys', async () => {
    const { user, onChange } = renderPicker('light');

    await user.tab();
    expect(radio('Light')).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(radio('Dark')).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('dark');

    await user.keyboard('{End}');
    expect(radio(/Auto/)).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('system');

    await user.keyboard('{Home}');
    expect(radio('Light')).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('light');
  });

  it('stays put at the edges and ignores other keys', async () => {
    const { user, onChange } = renderPicker('light');

    await user.tab();
    await user.keyboard('{ArrowLeft}');
    await user.keyboard('a');

    expect(radio('Light')).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });
});
