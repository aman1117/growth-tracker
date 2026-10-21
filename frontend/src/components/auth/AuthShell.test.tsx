import { render, screen } from '@testing-library/react';
import { Bell } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import formStyles from './AuthForms.module.css';
import { AuthShell } from './AuthShell';
import styles from './AuthShell.module.css';
import * as auth from './index';

describe('AuthShell', () => {
  it('shows the brand emblem, the title and the subtitle', () => {
    const { container } = render(<AuthShell title="Welcome back" subtitle="Log in to continue." />);

    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByText('Log in to continue.')).toBeInTheDocument();
    // The emblem is decorative, so it is hidden from assistive technology
    const emblem = container.querySelector(`.${styles.emblem}`);
    expect(emblem).toHaveAttribute('aria-hidden', 'true');
    expect(emblem?.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector(`.${styles.statusIcon}`)).not.toBeInTheDocument();
  });

  it('swaps the emblem for a tinted status icon', () => {
    const { container } = render(
      <AuthShell
        title="Check your inbox"
        icon={<Bell data-testid="status-icon" />}
        tone="success"
      />
    );

    const chip = container.querySelector(`.${styles.statusIcon}`);
    expect(chip).toHaveClass(styles.success);
    expect(chip).toHaveAttribute('aria-hidden', 'true');
    expect(chip).toContainElement(screen.getByTestId('status-icon'));
    expect(container.querySelector(`.${styles.emblem}`)).not.toBeInTheDocument();
  });

  it('uses the brand tone for status icons by default', () => {
    const { container } = render(<AuthShell title="Loading" icon={<Bell />} />);

    expect(container.querySelector(`.${styles.statusIcon}`)).toHaveClass(styles.brand);
  });

  it('wraps content in a card, optionally centered', () => {
    const { container, rerender } = render(
      <AuthShell title="Log in">
        <form aria-label="Log in form" />
      </AuthShell>
    );

    const card = container.querySelector(`.${styles.card}`);
    expect(card).toContainElement(screen.getByRole('form', { name: 'Log in form' }));
    expect(card).not.toHaveClass(styles.centered);

    rerender(
      <AuthShell title="Log in" centered>
        <form aria-label="Log in form" />
      </AuthShell>
    );
    expect(container.querySelector(`.${styles.card}`)).toHaveClass(styles.centered);
  });

  it('renders actions and a footer below the card', () => {
    render(
      <AuthShell
        title="Email verified!"
        actions={<button type="button">Continue</button>}
        footer={<a href="/login">Back to log in</a>}
      />
    );

    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to log in' })).toBeInTheDocument();
  });

  it('leaves out optional sections that were not provided', () => {
    const { container } = render(<AuthShell title="Just a title" />);

    expect(container.querySelector('p')).not.toBeInTheDocument();
    expect(container.querySelector(`.${styles.card}`)).not.toBeInTheDocument();
    expect(container.querySelector(`.${styles.actions}`)).not.toBeInTheDocument();
    expect(container.querySelector(`.${styles.footer}`)).not.toBeInTheDocument();
  });

  it('announces heading changes politely when live', () => {
    const { container, rerender } = render(<AuthShell title="Checking your link…" />);
    const hero = () => container.querySelector(`.${styles.hero}`);
    expect(hero()).not.toHaveAttribute('aria-live');

    rerender(<AuthShell title="Checking your link…" live />);
    expect(hero()).toHaveAttribute('aria-live', 'polite');
  });

  it('is exported with the shared form styles from the auth barrel', () => {
    expect(auth.AuthShell).toBe(AuthShell);
    expect(auth.authStyles).toBe(formStyles);
  });
});
