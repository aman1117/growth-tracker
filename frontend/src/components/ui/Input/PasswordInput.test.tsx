import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { PasswordInput } from './PasswordInput';

describe('PasswordInput', () => {
  it('hides the password by default and shows a lock icon', () => {
    const { container } = render(<PasswordInput label="Password" />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(container.querySelector('.lucide-lock')).toBeInTheDocument();
  });

  it('toggles visibility with the reveal button', async () => {
    const user = userEvent.setup();
    render(<PasswordInput label="Password" />);
    const input = screen.getByLabelText('Password');

    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('can be toggled from the keyboard after the field', async () => {
    const user = userEvent.setup();
    render(<PasswordInput label="Password" />);

    await user.tab();
    expect(screen.getByLabelText('Password')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    await user.keyboard(' ');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('disables the toggle together with the input', () => {
    render(<PasswordInput label="Password" disabled />);

    expect(screen.getByLabelText('Password')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
  });

  it('accepts a custom icon, Input props and a ref', async () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(
      <PasswordInput
        ref={ref}
        label="New password"
        icon={<span>key</span>}
        error="Too weak"
        autoComplete="new-password"
      />
    );
    const input = screen.getByLabelText('New password');

    expect(ref.current).toBe(input);
    expect(screen.getByText('key')).toBeInTheDocument();
    expect(container.querySelector('.lucide-lock')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(input).toHaveAccessibleDescription('Too weak');

    await userEvent.type(input, 'hunter2');
    expect(input).toHaveValue('hunter2');
  });
});
