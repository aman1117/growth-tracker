import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PRESET_COLOR_OPTIONS } from '../constants/colors';
import ColorPickerDefault, { ColorPicker } from './ColorPicker';
import styles from './ColorPicker.module.css';

type Props = ComponentProps<typeof ColorPicker>;

const BLUE = '#3b82f6';
const SKY = '#0ea5e9';
const RED = '#ef4444';
const VIOLET = '#8b5cf6';
const SLATE = '#64748b';

function renderPicker(props: Partial<Props> = {}) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const utils = render(<ColorPicker value={BLUE} onChange={onChange} {...props} />);
  const rerender = (next: Partial<Props>) =>
    utils.rerender(<ColorPicker value={BLUE} onChange={onChange} {...props} {...next} />);
  return { ...utils, rerender, user, onChange };
}

const hexInput = () => screen.getByRole('textbox', { name: 'Hex color code' });
const customToggle = () => screen.getByRole('button', { name: /custom/i });

describe('ColorPicker', () => {
  describe('preset palette', () => {
    it('renders every preset as a radio and checks the current color', () => {
      renderPicker();

      expect(screen.getByRole('radiogroup', { name: 'Preset colors' })).toBeInTheDocument();
      expect(screen.getAllByRole('radio')).toHaveLength(PRESET_COLOR_OPTIONS.length);
      expect(screen.getByRole('radio', { name: 'Blue' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Red' })).not.toBeChecked();
      expect(customToggle()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('textbox', { name: 'Hex color code' })).not.toBeInTheDocument();
    });

    it('matches a preset regardless of letter case', () => {
      renderPicker({ value: '#3B82F6' });

      expect(screen.getByRole('radio', { name: 'Blue' })).toBeChecked();
    });

    it('calls onChange with the preset color when a swatch is clicked', async () => {
      const { user, onChange } = renderPicker();

      await user.click(screen.getByRole('radio', { name: 'Red' }));

      expect(onChange).toHaveBeenCalledWith(RED);
    });

    it('is a single tab stop on the selected swatch', async () => {
      const { user } = renderPicker({ value: RED });

      expect(screen.getByRole('radio', { name: 'Red' })).toHaveAttribute('tabindex', '0');
      expect(screen.getByRole('radio', { name: 'Blue' })).toHaveAttribute('tabindex', '-1');

      await user.tab();
      expect(screen.getByRole('radio', { name: 'Red' })).toHaveFocus();
    });

    it('moves focus and selection with arrow, Home and End keys', async () => {
      const { user, onChange } = renderPicker();

      await user.tab();
      await user.keyboard('{ArrowRight}');
      expect(screen.getByRole('radio', { name: 'Sky' })).toHaveFocus();
      expect(onChange).toHaveBeenLastCalledWith(SKY);

      await user.keyboard('{End}');
      expect(screen.getByRole('radio', { name: 'Slate' })).toHaveFocus();
      expect(onChange).toHaveBeenLastCalledWith(SLATE);

      await user.keyboard('{Home}');
      expect(screen.getByRole('radio', { name: 'Blue' })).toHaveFocus();
      expect(onChange).toHaveBeenLastCalledWith(BLUE);
    });

    it('ignores keys that would not move the selection', async () => {
      const { user, onChange } = renderPicker();

      await user.tab();
      await user.keyboard('{ArrowLeft}x');

      expect(screen.getByRole('radio', { name: 'Blue' })).toHaveFocus();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('draws the check mark in a color that contrasts with the swatch', () => {
      const { unmount } = renderPicker({ value: '#f59e0b' });
      expect(screen.getByRole('radio', { name: 'Amber' }).querySelector('svg')).toHaveClass(
        styles.checkDark
      );
      unmount();

      renderPicker({ value: BLUE });
      expect(screen.getByRole('radio', { name: 'Blue' }).querySelector('svg')).toHaveClass(
        styles.checkLight
      );
    });
  });

  describe('custom color', () => {
    it('opens the editor for a color outside the palette and keeps the first swatch tabbable', () => {
      renderPicker({ value: '#123456' });

      expect(screen.queryByRole('radio', { checked: true })).not.toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Blue' })).toHaveAttribute('tabindex', '0');
      expect(customToggle()).toHaveAttribute('aria-expanded', 'true');
      expect(customToggle()).toHaveTextContent('Hide custom');
      expect(hexInput()).toHaveValue('#123456');
      expect(screen.getByLabelText('Pick a custom color')).toHaveValue('#123456');
    });

    it('toggles the editor with the custom color button', async () => {
      const { user } = renderPicker();

      await user.click(customToggle());
      expect(customToggle()).toHaveAttribute('aria-expanded', 'true');
      expect(hexInput()).toHaveValue(BLUE);

      await user.click(customToggle());
      expect(customToggle()).toHaveAttribute('aria-expanded', 'false');
      expect(customToggle()).toHaveTextContent('Custom color');
      expect(screen.queryByRole('textbox', { name: 'Hex color code' })).not.toBeInTheDocument();
    });

    it('accepts a hex code typed without the leading #', async () => {
      const { user, onChange } = renderPicker();
      await user.click(customToggle());

      await user.clear(hexInput());
      await user.type(hexInput(), 'ff0000');

      expect(hexInput()).toHaveValue('#ff0000');
      expect(onChange).toHaveBeenLastCalledWith('#ff0000');
    });

    it('expands a 3-digit hex code to lowercase 6-digit form', async () => {
      const { user, onChange } = renderPicker();
      await user.click(customToggle());

      await user.clear(hexInput());
      await user.type(hexInput(), '#ABC');

      expect(onChange).toHaveBeenLastCalledWith('#aabbcc');
      expect(hexInput()).toHaveValue('#ABC');
    });

    it('marks an invalid hex code and does not report it', async () => {
      const { user, onChange } = renderPicker();
      await user.click(customToggle());

      await user.clear(hexInput());
      await user.type(hexInput(), 'zz');

      expect(hexInput()).toHaveValue('#zz');
      expect(hexInput()).toHaveAttribute('aria-invalid', 'true');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('keeps a short hex while the parent echoes it back, but follows other external changes', async () => {
      const { user, rerender } = renderPicker();
      await user.click(customToggle());
      await user.clear(hexInput());
      await user.type(hexInput(), '#abc');

      rerender({ value: '#aabbcc' });
      expect(hexInput()).toHaveValue('#abc');

      rerender({ value: RED });
      expect(hexInput()).toHaveValue(RED);
    });

    it('reports colors from the native picker in lowercase', async () => {
      const { user, onChange } = renderPicker();
      await user.click(customToggle());

      fireEvent.change(screen.getByLabelText('Pick a custom color'), {
        target: { value: '#ABCDEF' },
      });

      expect(onChange).toHaveBeenCalledWith('#abcdef');
      expect(hexInput()).toHaveValue('#abcdef');
    });

    it('falls back to black in the native picker when the value is not a hex color', () => {
      renderPicker({ value: 'var(--accent)' });

      expect(screen.getByLabelText('Pick a custom color')).toHaveValue('#000000');
      expect(hexInput()).toHaveAttribute('aria-invalid', 'true');
    });
  });

  describe('reset to default', () => {
    it('restores the default color and notifies the parent', async () => {
      const onReset = vi.fn();
      const { user, onChange } = renderPicker({
        value: '#123456',
        defaultColor: VIOLET,
        showResetButton: true,
        onReset,
      });

      await user.click(screen.getByRole('button', { name: 'Reset' }));

      expect(onChange).toHaveBeenCalledWith(VIOLET);
      expect(onReset).toHaveBeenCalledTimes(1);
      expect(hexInput()).toHaveValue(VIOLET);
    });

    it.each([
      ['the color already is the default', { value: '#8B5CF6', defaultColor: VIOLET }],
      ['reset is not enabled', { value: RED, defaultColor: VIOLET, showResetButton: false }],
      ['there is no default color', { value: RED, defaultColor: undefined }],
    ])('is hidden when %s', (_label, props) => {
      renderPicker({ showResetButton: true, ...props });

      expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    });
  });

  it('is exported as the default export', () => {
    expect(ColorPickerDefault).toBe(ColorPicker);
  });
});
