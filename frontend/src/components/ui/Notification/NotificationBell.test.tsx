import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useNotificationStore } from '../../../store';
import styles from './Notification.module.css';
import { NotificationBell } from './NotificationBell';

describe('NotificationBell', () => {
  it('is labelled "Notifications" without a badge when everything is read', () => {
    render(<NotificationBell onClick={vi.fn()} isOpen={false} />);
    const bell = screen.getByRole('button', { name: 'Notifications' });

    expect(bell).toHaveAttribute('aria-expanded', 'false');
    expect(bell).not.toHaveClass(styles.bellActive);
    expect(bell.querySelector(`.${styles.badge}`)).not.toBeInTheDocument();
  });

  it('announces and shows the unread count', () => {
    useNotificationStore.setState({ unreadCount: 3 });
    render(<NotificationBell onClick={vi.fn()} isOpen={false} />);
    const bell = screen.getByRole('button', { name: 'Notifications (3 unread)' });
    const badge = bell.querySelector(`.${styles.badge}`);

    expect(badge).toHaveTextContent('3');
    expect(badge).toHaveAttribute('aria-hidden', 'true');
  });

  it('caps the badge at 99+', () => {
    useNotificationStore.setState({ unreadCount: 150 });
    render(<NotificationBell onClick={vi.fn()} isOpen={false} />);

    const bell = screen.getByRole('button', { name: 'Notifications (150 unread)' });
    expect(bell.querySelector(`.${styles.badge}`)).toHaveTextContent('99+');
  });

  it('updates live when new notifications arrive', () => {
    render(<NotificationBell onClick={vi.fn()} isOpen={false} />);

    act(() => useNotificationStore.setState({ unreadCount: 1 }));
    expect(screen.getByRole('button', { name: 'Notifications (1 unread)' })).toBeInTheDocument();
  });

  it('reflects the open panel', () => {
    render(<NotificationBell onClick={vi.fn()} isOpen />);
    const bell = screen.getByRole('button', { name: 'Notifications' });

    expect(bell).toHaveAttribute('aria-expanded', 'true');
    expect(bell).toHaveClass(styles.bellButton, styles.bellActive);
  });

  it('calls onClick from mouse and keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<NotificationBell onClick={onClick} isOpen={false} />);

    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});
