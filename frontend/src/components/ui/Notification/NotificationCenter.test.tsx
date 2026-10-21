import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWebSocket } from '../../../hooks';
import { useNotificationStore } from '../../../store';
import { makeNotification } from '../../../test/fixtures/ui';
import { renderWithRouter, signIn } from '../../../test/utils';
import { NotificationCenter } from './NotificationCenter';

vi.mock('../../../hooks', () => ({ useWebSocket: vi.fn() }));

const notification = makeNotification();

function renderCenter() {
  const onNotificationClick = vi.fn();
  const onUsernameClick = vi.fn();
  const onOpen = vi.fn();
  const utils = renderWithRouter(
    <NotificationCenter
      onNotificationClick={onNotificationClick}
      onUsernameClick={onUsernameClick}
      onOpen={onOpen}
    />
  );
  return { onNotificationClick, onUsernameClick, onOpen, ...utils };
}

const bell = () => screen.getByRole('button', { name: /^Notifications/ });

describe('NotificationCenter', () => {
  beforeEach(() => {
    useNotificationStore.setState({
      notifications: [notification],
      unreadCount: 1,
      hasMore: false,
      fetchNotifications: vi.fn(async () => {}),
      markAsRead: vi.fn(async () => {}),
      markAllAsRead: vi.fn(async () => {}),
      startDeleting: vi.fn(),
      deleteNotification: vi.fn(async () => {}),
    });
  });

  it('renders nothing and keeps the socket off for signed-out visitors', () => {
    const { container } = renderCenter();

    expect(container.querySelector('button')).toBeNull();
    expect(useWebSocket).toHaveBeenCalledWith({ enabled: false });
  });

  it('connects the socket and shows the bell for signed-in users', () => {
    signIn();
    renderCenter();

    expect(useWebSocket).toHaveBeenLastCalledWith({ enabled: true });
    expect(bell()).toHaveAccessibleName('Notifications (1 unread)');
    expect(bell()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the panel from the bell and tells the parent', async () => {
    signIn();
    const { user, onOpen } = renderCenter();

    await user.click(bell());

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(bell()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('toggles closed from the keyboard without notifying onOpen again', async () => {
    signIn();
    const { user, onOpen } = renderCenter();

    act(() => bell().focus());
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(bell()).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('closes the panel on Escape', async () => {
    signIn();
    const { user } = renderCenter();

    await user.click(bell());
    await user.keyboard('{Escape}');

    expect(bell()).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes the panel when the bell is clicked again', async () => {
    signIn();
    const { user, onOpen } = renderCenter();

    await user.click(bell());
    await user.click(bell());

    expect(bell()).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onOpen).toHaveBeenCalledTimes(1);

    // The next click opens it again
    await user.click(bell());
    expect(bell()).toHaveAttribute('aria-expanded', 'true');
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('still closes the panel on a press outside it and the bell', async () => {
    signIn();
    const { user } = renderCenter();

    await user.click(bell());
    await user.click(document.body);

    expect(bell()).toHaveAttribute('aria-expanded', 'false');
  });

  it('reports a clicked notification and closes the panel', async () => {
    signIn();
    const { user, onNotificationClick } = renderCenter();

    await user.click(bell());
    await user.click(within(screen.getByRole('dialog')).getByText('New like'));

    expect(onNotificationClick).toHaveBeenCalledExactlyOnceWith(notification);
    expect(bell()).toHaveAttribute('aria-expanded', 'false');
  });

  it('reports a clicked liker and closes the panel', async () => {
    signIn();
    const { user, onUsernameClick } = renderCenter();

    await user.click(bell());
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'alice' }));

    expect(onUsernameClick).toHaveBeenCalledExactlyOnceWith('alice');
    expect(bell()).toHaveAttribute('aria-expanded', 'false');
  });

  it('works without any callbacks', async () => {
    signIn();
    const { user } = renderWithRouter(<NotificationCenter />);

    await user.click(bell());
    await user.click(within(screen.getByRole('dialog')).getByText('New like'));
    expect(bell()).toHaveAttribute('aria-expanded', 'false');

    await user.click(bell());
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'alice' }));
    expect(bell()).toHaveAttribute('aria-expanded', 'false');
  });
});
