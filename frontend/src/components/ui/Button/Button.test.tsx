import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button, type ButtonSize, type ButtonVariant } from './Button';
import styles from './Button.module.css';

const Icon = ({ name }: { name: string }) => <svg aria-hidden="true" data-icon={name} />;

describe('Button', () => {
  it('renders its label with the default primary/md styling', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });

    expect(button).toHaveClass(styles.button, styles.primary, styles.md);
    expect(button).toBeEnabled();
    expect(button).not.toHaveClass(styles.fullWidth);
    expect(button).not.toHaveClass(styles.loading);
  });

  it.each<ButtonVariant>(['primary', 'secondary', 'danger', 'ghost', 'outline', 'glass'])(
    'applies the %s variant',
    (variant) => {
      render(<Button variant={variant}>Go</Button>);
      expect(screen.getByRole('button', { name: 'Go' })).toHaveClass(styles[variant]);
    }
  );

  it.each<ButtonSize>(['xs', 'sm', 'md', 'lg'])('applies the %s size', (size) => {
    render(<Button size={size}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass(styles[size]);
  });

  it('calls onClick and supports keyboard activation', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });

    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.click(button);

    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('is disabled and ignores clicks when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>
    );

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows a spinner, hides icons and blocks clicks while loading', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button
        loading
        onClick={onClick}
        icon={<Icon name="left" />}
        iconRight={<Icon name="right" />}
      >
        Save
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Save' });

    expect(button).toBeDisabled();
    expect(button).toHaveClass(styles.loading);
    expect(container.querySelector(`.${styles.spinner}`)).toBeInTheDocument();
    expect(container.querySelector('[data-icon]')).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders leading and trailing icons around the label', () => {
    const { container } = render(
      <Button icon={<Icon name="left" />} iconRight={<Icon name="right" />}>
        Save
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Save' });
    const [left, label, right] = Array.from(button.children);

    expect(left).toHaveClass(styles.icon);
    expect(left).toContainElement(container.querySelector('[data-icon="left"]'));
    expect(label).toHaveClass(styles.text);
    expect(right).toHaveClass(styles.iconRight);
    expect(right).toContainElement(container.querySelector('[data-icon="right"]'));
  });

  it('renders only the icon in icon-only mode', () => {
    render(
      <Button iconOnly icon={<Icon name="star" />} aria-label="Favorite">
        Favorite
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Favorite' });

    expect(button).toHaveClass(styles.iconOnly);
    expect(button.querySelector('[data-icon="star"]')).toBeInTheDocument();
    expect(button).not.toHaveTextContent('Favorite');
  });

  it('renders the hover label and hover variant (e.g. Following → Unfollow)', () => {
    render(
      <Button variant="outline" hoverLabel="Unfollow" hoverVariant="danger">
        Following
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Following' });

    expect(button).toHaveClass(styles.hasHoverLabel, styles.hoverDanger);
    expect(screen.getByText('Unfollow')).toHaveClass(styles.hoverText);
    expect(screen.getByText('Following')).toHaveClass(styles.text);
  });

  it('keeps the visible label as the name and hides the hover label from assistive tech', () => {
    render(<Button hoverLabel={<strong>Unfollow</strong>}>Following</Button>);
    const button = screen.getByRole('button');

    expect(button).toHaveAccessibleName('Following');
    expect(screen.getByText('Unfollow').parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Following')).not.toHaveAttribute('aria-hidden');
  });

  it('stretches to full width and keeps custom classes', () => {
    render(
      <Button fullWidth className="cta">
        Join
      </Button>
    );
    expect(screen.getByRole('button', { name: 'Join' })).toHaveClass(styles.fullWidth, 'cta');
  });

  it('forwards native attributes and the ref to the button element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} type="submit" form="settings" name="intent">
        Submit
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Submit' });

    expect(ref.current).toBe(button);
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveAttribute('form', 'settings');
    expect(button).toHaveAttribute('name', 'intent');
  });
});
