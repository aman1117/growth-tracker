import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeNotification } from '../../../test/fixtures/ui';
import type { Notification } from '../../../types';
import styles from './Notification.module.css';
import { NotificationItem } from './NotificationItem';
import tones from './NotificationTone.module.css';

const NOW = new Date('2026-10-21T10:00:00.000Z');

type ItemProps = Partial<ComponentProps<typeof NotificationItem>>;

function renderItem(props: ItemProps = {}, notification: Notification = makeNotification()) {
  const handlers = {
    onMarkAsRead: vi.fn(),
    onStartDeleting: vi.fn(),
    onDelete: vi.fn(),
    onClick: vi.fn(),
    onUsernameClick: vi.fn(),
  };
  const utils = render(<NotificationItem notification={notification} {...handlers} {...props} />);
  const item = screen.getByText(notification.title).closest('[role="button"]') as HTMLElement;
  return { ...handlers, item, notification, ...utils };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('NotificationItem', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('shows the title, body, age and an unread marker', () => {
    const { item } = renderItem();

    expect(item).toHaveAttribute('tabindex', '0');
    expect(item).toHaveTextContent('New like · alice liked your day');
    expect(item).toHaveTextContent('5m ago');
    expect(item).toHaveClass(styles.item, styles.itemUnread);
    expect(item.querySelector(`.${styles.unreadDot}`)).toHaveAttribute('aria-hidden', 'true');
    expect(item.querySelector(`.${styles.itemIcon}`)).toHaveClass(tones.like);
  });

  it('has no unread marker once read', () => {
    const { item } = renderItem(
      {},
      makeNotification({ read_at: '2026-10-21T09:58:00.000Z', created_at: '2026-10-20T07:00:00Z' })
    );

    expect(item).not.toHaveClass(styles.itemUnread);
    expect(item.querySelector(`.${styles.unreadDot}`)).not.toBeInTheDocument();
    expect(item).toHaveTextContent('1d ago');
  });

  it('highlights newly arrived items', () => {
    expect(renderItem({ isNew: true }).item).toHaveClass(styles.itemNew);
  });

  it('marks an unread item as read, opens it, then removes it', () => {
    const { item, onMarkAsRead, onClick, onStartDeleting, onDelete, notification } = renderItem();

    fireEvent.click(item);
    expect(onMarkAsRead).toHaveBeenCalledExactlyOnceWith(1);
    expect(onClick).toHaveBeenCalledExactlyOnceWith(notification);
    expect(onStartDeleting).not.toHaveBeenCalled();

    // Removed after the panel has had time to close, with a delete animation
    advance(50);
    expect(onStartDeleting).toHaveBeenCalledExactlyOnceWith(1);
    expect(onDelete).not.toHaveBeenCalled();
    advance(250);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('does not mark a read item again', () => {
    const { item, onMarkAsRead, onClick } = renderItem(
      {},
      makeNotification({ read_at: '2026-10-21T09:58:00.000Z' })
    );

    fireEvent.click(item);
    expect(onMarkAsRead).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Enter', 'Enter'],
    ['Space', ' '],
  ])('opens with %s but not with other keys', (_name, key) => {
    const { item, onClick, onMarkAsRead } = renderItem();

    fireEvent.keyDown(item, { key: 'a' });
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.keyDown(item, { key });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onMarkAsRead).toHaveBeenCalledTimes(1);
  });

  it('keeps Space from scrolling the page', () => {
    const { item } = renderItem();

    expect(fireEvent.keyDown(item, { key: ' ' })).toBe(false);
    expect(fireEvent.keyDown(item, { key: 'a' })).toBe(true);
  });

  it('leaves Enter and Space on its inner buttons to those buttons', () => {
    const { onClick, onMarkAsRead, onStartDeleting } = renderItem();
    const innerButtons = [
      screen.getByRole('button', { name: 'Delete notification' }),
      screen.getByRole('button', { name: 'alice' }),
    ];

    for (const button of innerButtons) {
      fireEvent.keyDown(button, { key: 'Enter' });
      // Not prevented, so the button's own Space activation still happens
      expect(fireEvent.keyDown(button, { key: ' ' })).toBe(true);
    }
    advance(500);

    expect(onClick).not.toHaveBeenCalled();
    expect(onMarkAsRead).not.toHaveBeenCalled();
    expect(onStartDeleting).not.toHaveBeenCalled();
  });

  it('still marks as read and removes the item without an onClick handler', () => {
    const { item, onMarkAsRead, onDelete } = renderItem({ onClick: undefined });

    fireEvent.click(item);
    advance(300);

    expect(onMarkAsRead).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(1);
  });

  it('deletes from the X button without opening or marking the item', () => {
    const { onStartDeleting, onDelete, onClick, onMarkAsRead } = renderItem();

    fireEvent.click(screen.getByRole('button', { name: 'Delete notification' }));

    expect(onStartDeleting).toHaveBeenCalledExactlyOnceWith(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(onMarkAsRead).not.toHaveBeenCalled();
    advance(249);
    expect(onDelete).not.toHaveBeenCalled();
    advance(1);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('ignores clicks, keys and deletes while it is being deleted', () => {
    const { item, onClick, onStartDeleting, onMarkAsRead } = renderItem({ isDeleting: true });

    fireEvent.click(item);
    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete notification' }));
    advance(1000);

    expect(item).toHaveClass(styles.itemDeleting);
    expect(onClick).not.toHaveBeenCalled();
    expect(onMarkAsRead).not.toHaveBeenCalled();
    expect(onStartDeleting).not.toHaveBeenCalled();
  });

  describe('liker name', () => {
    it('links the liker without opening the notification', () => {
      const { onUsernameClick, onMarkAsRead, onClick, onStartDeleting } = renderItem();

      fireEvent.click(screen.getByRole('button', { name: 'alice' }));
      advance(1000);

      expect(onUsernameClick).toHaveBeenCalledExactlyOnceWith('alice');
      expect(onMarkAsRead).toHaveBeenCalledExactlyOnceWith(1);
      expect(onClick).not.toHaveBeenCalled();
      expect(onStartDeleting).not.toHaveBeenCalled();
    });

    it('does not mark a read notification again', () => {
      const { onUsernameClick, onMarkAsRead } = renderItem(
        {},
        makeNotification({ read_at: '2026-10-21T09:58:00.000Z' })
      );

      fireEvent.click(screen.getByRole('button', { name: 'alice' }));
      expect(onUsernameClick).toHaveBeenCalledTimes(1);
      expect(onMarkAsRead).not.toHaveBeenCalled();
    });

    it('does nothing without a username handler', () => {
      const { onMarkAsRead, onClick } = renderItem({ onUsernameClick: undefined });

      fireEvent.click(screen.getByRole('button', { name: 'alice' }));
      expect(onMarkAsRead).not.toHaveBeenCalled();
      expect(onClick).not.toHaveBeenCalled();
    });

    it('is linked for story likes too, keeping repeated mentions as text', () => {
      const { item } = renderItem(
        {},
        makeNotification({
          type: 'story_liked',
          title: 'Story like',
          body: 'bob liked your story, thanks bob',
          metadata: { liker_id: 3, liker_username: 'bob', photo_id: 9, photo_date: '2026-10-20' },
        })
      );

      expect(screen.getAllByRole('button', { name: 'bob' })).toHaveLength(1);
      expect(item).toHaveTextContent('bob liked your story, thanks bob');
    });

    it.each([
      ['the body does not mention the liker', makeNotification({ body: 'Someone liked your day' })],
      ['the metadata is missing', makeNotification({ metadata: null })],
      [
        'it is not a like',
        makeNotification({
          type: 'comment_received',
          title: 'New comment',
          body: 'alice commented on your day',
        }),
      ],
    ])('is plain text when %s', (_case, notification) => {
      renderItem({}, notification);
      expect(screen.queryByRole('button', { name: 'alice' })).not.toBeInTheDocument();
    });
  });
});
