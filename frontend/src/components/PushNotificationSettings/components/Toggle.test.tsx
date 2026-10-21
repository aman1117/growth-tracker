import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Toggle } from './Toggle';

function renderToggle(props: Partial<ComponentProps<typeof Toggle>> = {}) {
  const onChange = vi.fn();
  render(
    <>
      <span id="likes-label">Likes</span>
      <span id="likes-description">When someone likes your day</span>
      <Toggle
        id="likes"
        enabled={false}
        onChange={onChange}
        aria-labelledby="likes-label"
        aria-describedby="likes-description"
        {...props}
      />
    </>
  );
  return { user: userEvent.setup(), onChange };
}

describe('push settings Toggle', () => {
  it('is a switch named and described by the row it sits in', () => {
    renderToggle({ enabled: true });

    const toggle = screen.getByRole('switch', { name: 'Likes' });
    expect(toggle).toHaveAttribute('id', 'likes');
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription('When someone likes your day');
  });

  it('reports the next value when flipped', async () => {
    const { user, onChange } = renderToggle({ enabled: false });

    await user.click(screen.getByRole('switch', { name: 'Likes' }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('can be disabled', async () => {
    const { user, onChange } = renderToggle({ disabled: true });

    const toggle = screen.getByRole('switch', { name: 'Likes' });
    expect(toggle).toBeDisabled();
    await user.click(toggle);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('stays focusable but ignores input while busy', async () => {
    const { user, onChange } = renderToggle({ busy: true });

    const toggle = screen.getByRole('switch', { name: 'Likes' });
    await user.click(toggle);
    await user.keyboard('{Enter}');

    expect(toggle).toBeEnabled();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-busy', 'true');
    expect(onChange).not.toHaveBeenCalled();
  });
});
