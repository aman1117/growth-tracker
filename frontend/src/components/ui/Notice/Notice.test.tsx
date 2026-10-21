import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Notice, NoticeStack, type NoticeTone } from './Notice';
import styles from './Notice.module.css';

describe('Notice', () => {
  it('renders a polite status with the brand tone by default', () => {
    render(<Notice title="You're offline" />);
    const notice = screen.getByRole('status');

    expect(notice).toHaveTextContent("You're offline");
    expect(notice).toHaveClass(styles.notice, styles.brand);
    expect(notice).not.toHaveClass(styles.leaving);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('can announce urgent problems as an alert', () => {
    render(<Notice role="alert" tone="danger" title="Sync failed" />);
    expect(screen.getByRole('alert')).toHaveClass(styles.danger);
  });

  it.each<NoticeTone>(['brand', 'info', 'success', 'warning', 'danger'])(
    'applies the %s tone',
    (tone) => {
      render(<Notice tone={tone} title="Heads up" />);
      expect(screen.getByRole('status')).toHaveClass(styles[tone]);
    }
  );

  it('renders the icon chip (hidden from assistive tech) and the description', () => {
    render(
      <Notice icon={<svg data-icon="wifi" />} title="Offline" description="Changes sync later." />
    );
    const notice = screen.getByRole('status');

    expect(screen.getByText('Changes sync later.')).toHaveClass(styles.description);
    expect(notice.querySelector(`.${styles.iconChip}`)).toHaveAttribute('aria-hidden', 'true');
    expect(notice.querySelector('[data-icon="wifi"]')).toBeInTheDocument();
  });

  it('runs the action when clicked', async () => {
    const onClick = vi.fn();
    render(
      <Notice
        title="Verify your email"
        action={{ label: 'Resend', onClick, icon: <svg aria-hidden="true" data-icon="mail" /> }}
      />
    );

    const action = screen.getByRole('button', { name: 'Resend' });
    expect(action.querySelector('[data-icon="mail"]')).toBeInTheDocument();
    await userEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disables the action during a cooldown', async () => {
    const onClick = vi.fn();
    render(<Notice title="Verify" action={{ label: 'Resend', onClick, disabled: true }} />);

    const action = screen.getByRole('button', { name: 'Resend' });
    expect(action).toBeDisabled();
    await userEvent.click(action);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows a labelled dismiss button only when dismissible', async () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Notice title="Update ready" onDismiss={onDismiss} />);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rerender(<Notice title="Update ready" onDismiss={onDismiss} dismissLabel="Hide update" />);
    expect(screen.getByRole('button', { name: 'Hide update' })).toBeInTheDocument();
  });

  it('plays the exit animation while leaving and keeps custom classes', () => {
    render(<Notice title="Bye" leaving className="custom" />);
    expect(screen.getByRole('status')).toHaveClass(styles.leaving, 'custom');
  });
});

describe('NoticeStack', () => {
  it('stacks notices in a polite live region', () => {
    const { container } = render(
      <NoticeStack>
        <Notice title="One" />
        <Notice title="Two" />
      </NoticeStack>
    );
    const stack = container.firstElementChild;

    expect(stack).toHaveClass(styles.stack);
    expect(stack).toHaveAttribute('aria-live', 'polite');
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });
});
