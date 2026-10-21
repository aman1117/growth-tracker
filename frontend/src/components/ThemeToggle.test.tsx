import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { gl } from '../services/goodlogs';
import { useThemeStore } from '../store';
import { ThemeToggle } from './ThemeToggle';

describe('ThemeToggle', () => {
  it('switches a light screen to dark mode', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const toggle = screen.getByRole('button', { name: 'Switch to dark mode' });
    expect(toggle).toHaveAttribute('title', 'Switch to dark mode');

    await user.click(toggle);

    expect(gl.track).toHaveBeenCalledWith('theme_toggled', { properties: { to: 'dark' } });
    expect(useThemeStore.getState()).toMatchObject({ theme: 'dark', isDark: true });
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toHaveAttribute(
      'title',
      'Switch to light mode'
    );
  });

  it('switches a dark screen to light mode', async () => {
    useThemeStore.getState().setTheme('dark');
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: 'Switch to light mode' }));

    expect(gl.track).toHaveBeenCalledWith('theme_toggled', { properties: { to: 'light' } });
    expect(useThemeStore.getState()).toMatchObject({ theme: 'light', isDark: false });
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('works from the keyboard', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(useThemeStore.getState().isDark).toBe(true);

    await user.keyboard(' ');
    expect(useThemeStore.getState().isDark).toBe(false);
  });
});
