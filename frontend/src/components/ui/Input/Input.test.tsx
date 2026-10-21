import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Input } from './Input';
import styles from './Input.module.css';

describe('Input', () => {
  it('labels the input and derives its id from the label', () => {
    render(<Input label="Email address" type="email" />);
    const input = screen.getByLabelText('Email address');

    expect(input).toHaveAttribute('id', 'email-address');
    expect(input).toHaveAttribute('type', 'email');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('prefers an explicit id', () => {
    render(<Input label="Username" id="signup-username" />);
    expect(screen.getByLabelText('Username')).toHaveAttribute('id', 'signup-username');
  });

  it('generates an id when there is no label', () => {
    render(<Input placeholder="Search" />);
    expect(screen.getByPlaceholderText('Search').id).not.toBe('');
    expect(screen.queryByText(/./, { selector: 'label' })).not.toBeInTheDocument();
  });

  it('announces an error and links it to the input', () => {
    render(<Input label="Password" error="Too short" helperText="At least 8 characters" />);
    const input = screen.getByLabelText('Password');
    const error = screen.getByRole('alert');

    expect(error).toHaveTextContent('Too short');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Too short');
    expect(screen.queryByText('At least 8 characters')).not.toBeInTheDocument();
    expect(error.previousElementSibling).toHaveClass(styles.hasError);
  });

  it('shows helper text as the description when there is no error', () => {
    render(<Input label="Bio" helperText="Max 160 characters" />);

    expect(screen.getByLabelText('Bio')).toHaveAccessibleDescription('Max 160 characters');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('merges an external aria-describedby with its own message', () => {
    render(
      <>
        <p id="hint">Visible to followers</p>
        <Input label="Status" aria-describedby="hint" helperText="Optional" />
      </>
    );

    expect(screen.getByLabelText('Status')).toHaveAccessibleDescription(
      'Visible to followers Optional'
    );
  });

  it('keeps an external aria-describedby when it has no message', () => {
    render(
      <>
        <p id="hint">Shown publicly</p>
        <Input label="Website" aria-describedby="hint" />
      </>
    );
    expect(screen.getByLabelText('Website')).toHaveAttribute('aria-describedby', 'hint');
  });

  it('renders left and right icons', () => {
    render(<Input label="Amount" icon={<span>$</span>} iconRight={<span>USD</span>} />);

    expect(screen.getByText('$').parentElement).toHaveClass(styles.icon);
    expect(screen.getByText('USD').parentElement).toHaveClass(styles.iconRight);
  });

  it('is full width by default and can opt out', () => {
    const { container, rerender } = render(<Input label="Name" className="field" />);
    expect(container.firstElementChild).toHaveClass(styles.wrapper, styles.fullWidth, 'field');

    rerender(<Input label="Name" fullWidth={false} />);
    expect(container.firstElementChild).not.toHaveClass(styles.fullWidth);
  });

  it('forwards the ref and native props such as onChange', async () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(<Input ref={ref} label="City" onChange={onChange} />);
    const input = screen.getByLabelText('City');

    expect(ref.current).toBe(input);
    await userEvent.type(input, 'Pune');
    expect(input).toHaveValue('Pune');
    expect(onChange).toHaveBeenCalledTimes(4);
  });
});
