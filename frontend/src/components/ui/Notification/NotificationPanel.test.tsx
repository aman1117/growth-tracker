import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useNotificationStore } from '../../../store';
import { makeNotification } from '../../../test/fixtures/ui';
import type { NotificationState } from '../../../types';
import styles from './Notification.module.css';
import { NotificationPanel } from './NotificationPanel';

const unread = makeNotification({ id: 1 });
const read = makeNotification({
  id: 2,
  type: 'new_follower',
  title: 'New follower',
  body: 'carol started following you',
  metadata: null,
  read_at: '2026-10-21T09:00:00.000Z',
});

/** Seeds the notification store and replaces its API-backed actions with spies. */
function seedStore(state: Partial<NotificationState> = {}) {
  const actions = {
    fetchNotifications: vi.fn(async () => {}),
    markAsRead: vi.fn(async () => {}),
    markAllAsRead: vi.fn(async () => {}),
    startDeleting: vi.fn(),
    deleteNotification: vi.fn(async () => {}),
  };
  useNotificationStore.setState({ ...actions, ...state });
  return actions;
}

function renderPanel(props: Partial<ComponentProps<typeof NotificationPanel>> = {}) {
  const onClose = vi.fn();
  const onNotificationClick = vi.fn();
  const onUsernameClick = vi.fn();
  const utils = render(
    <NotificationPanel
      isOpen
      onClose={onClose}
      onNotificationClick={onNotificationClick}
      onUsernameClick={onUsernameClick}
      {...props}
    />
  );
  return { onClose, onNotificationClick, onUsernameClick, ...utils };
}

const listOf = (dialog: HTMLElement) => dialog.querySelector(`.${styles.panelList}`) as HTMLElement;

const itemTitled = (title: string) => screen.getByText(title).closest('[role="button"]');

const setMobile = (mobile: boolean) => vi.stubGlobal('innerWidth', mobile ? 375 : 1024);

const resize = () =>
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });

describe('NotificationPanel', () => {
  it('renders and fetches nothing while closed', () => {
    const { fetchNotifications } = seedStore();
    renderPanel({ isOpen: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchNotifications).not.toHaveBeenCalled();
  });

  it('loads the first page when opened empty and shows the empty state', () => {
    const { fetchNotifications } = seedStore();
    const { container } = renderPanel();
    const dialog = screen.getByRole('dialog', { name: 'Notifications' });

    expect(fetchNotifications).toHaveBeenCalledExactlyOnceWith(true);
    expect(within(dialog).getByText("You're all caught up")).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Refresh notifications' })).toBeEnabled();
    expect(within(dialog).queryByRole('button', { name: 'Mark all as read' })).toBeNull();
    // Desktop: an inline dropdown without a backdrop or close button
    expect(container).toContainElement(dialog);
    expect(dialog).not.toHaveClass(styles.panelMobile);
    expect(within(dialog).queryByRole('button', { name: 'Close notifications' })).toBeNull();
  });

  it('shows a loader while the first page loads', () => {
    seedStore({ isLoading: true });
    renderPanel();

    expect(screen.getByText('Loading notifications...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh notifications' })).toBeDisabled();
  });

  it('lists notifications with the unread count and the end of the list', () => {
    const { fetchNotifications } = seedStore({
      notifications: [unread, read],
      unreadCount: 1,
      hasMore: false,
    });
    renderPanel();
    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    const heading = within(dialog).getByRole('heading', { name: /^Notifications/ });

    expect(fetchNotifications).not.toHaveBeenCalled();
    expect(within(heading).getByText('1')).toHaveClass(styles.unreadBadge);
    expect(itemTitled('New like')).toHaveTextContent('alice liked your day');
    expect(itemTitled('New follower')).toHaveTextContent('carol started following you');
    expect(within(dialog).getByText("That's all your notifications")).toBeInTheDocument();
  });

  it('shows a loader below the list while the next page loads', () => {
    seedStore({ notifications: [unread], isLoading: true, hasMore: true });
    renderPanel();

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText("That's all your notifications")).not.toBeInTheDocument();
  });

  it('marks everything as read and refreshes on demand', async () => {
    const user = userEvent.setup();
    const { markAllAsRead, fetchNotifications } = seedStore({
      notifications: [unread],
      unreadCount: 1,
    });
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(markAllAsRead).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Refresh notifications' }));
    expect(fetchNotifications).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('logs instead of crashing when marking everything as read fails', async () => {
    const error = new Error('offline');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { markAllAsRead } = seedStore({ notifications: [unread], unreadCount: 1 });
    markAllAsRead.mockRejectedValue(error);
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('Failed to mark all as read:', error)
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  describe('infinite scroll', () => {
    const scrollList = (scrollTop: number) => {
      const list = listOf(screen.getByRole('dialog'));
      Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true });
      list.scrollTop = scrollTop;
      fireEvent.scroll(list);
    };

    it('loads the next page near the bottom', () => {
      const { fetchNotifications } = seedStore({ notifications: [unread], hasMore: true });
      renderPanel();

      scrollList(100);
      expect(fetchNotifications).not.toHaveBeenCalled();

      scrollList(550);
      expect(fetchNotifications).toHaveBeenCalledExactlyOnceWith();
    });

    it.each([
      ['everything is loaded', { hasMore: false }],
      ['a page is already loading', { hasMore: true, isLoading: true }],
    ])('does nothing when %s', (_case, state) => {
      const { fetchNotifications } = seedStore({ notifications: [unread], ...state });
      renderPanel();

      scrollList(600);
      expect(fetchNotifications).not.toHaveBeenCalled();
    });
  });

  it('passes item actions to the store and the parent', async () => {
    const user = userEvent.setup();
    const actions = seedStore({ notifications: [unread], unreadCount: 1 });
    const { onNotificationClick, onUsernameClick } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'alice' }));
    expect(onUsernameClick).toHaveBeenCalledExactlyOnceWith('alice');
    expect(actions.markAsRead).toHaveBeenCalledExactlyOnceWith(1);

    await user.click(screen.getByText('New like'));
    expect(onNotificationClick).toHaveBeenCalledExactlyOnceWith(unread);
    await waitFor(() => expect(actions.deleteNotification).toHaveBeenCalledWith(1));
    expect(actions.startDeleting).toHaveBeenCalledWith(1);
  });

  it('shows items that are being deleted as such', () => {
    seedStore({ notifications: [unread, read], deletingIds: { 2: true } });
    renderPanel();

    expect(itemTitled('New follower')).toHaveClass(styles.itemDeleting);
    expect(itemTitled('New like')).not.toHaveClass(styles.itemDeleting);
  });

  it('closes on Escape and on clicks outside, but not on clicks inside', () => {
    seedStore({ notifications: [unread] });
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Elsewhere</button>
        <NotificationPanel isOpen onClose={onClose} />
      </>
    );

    fireEvent.mouseDown(screen.getByText('New like'));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('leaves presses on its trigger to the trigger, so a toggle can close it', () => {
    seedStore({ notifications: [unread] });
    const onClose = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <>
        <button type="button" ref={triggerRef}>
          Bell
        </button>
        <NotificationPanel isOpen onClose={onClose} triggerRef={triggerRef} />
      </>
    );

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Bell' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps touch gestures inside the panel', () => {
    seedStore({ notifications: [unread] });
    const onPageTouch = vi.fn();
    render(
      <div onTouchStart={onPageTouch} onTouchMove={onPageTouch}>
        <NotificationPanel isOpen onClose={vi.fn()} />
      </div>
    );
    const dialog = screen.getByRole('dialog');

    fireEvent.touchStart(dialog, { touches: [{ clientX: 0, clientY: 0 }] });
    fireEvent.touchMove(dialog, { touches: [{ clientX: 0, clientY: 50 }] });
    expect(onPageTouch).not.toHaveBeenCalled();
  });

  it('plays a closing animation before disappearing, unless reopened', async () => {
    seedStore();
    const { rerender, onClose } = renderPanel();
    const dialog = screen.getByRole('dialog');

    rerender(<NotificationPanel isOpen={false} onClose={onClose} />);
    expect(dialog).toHaveClass(styles.panelClosing);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    rerender(<NotificationPanel isOpen onClose={onClose} />);
    rerender(<NotificationPanel isOpen={false} onClose={onClose} />);
    rerender(<NotificationPanel isOpen onClose={onClose} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(screen.getByRole('dialog')).not.toHaveClass(styles.panelClosing);
  });

  describe('on phones', () => {
    it('opens as a sheet with a backdrop and a close button, in a portal', async () => {
      setMobile(true);
      seedStore();
      const { container, onClose } = renderPanel();
      const dialog = screen.getByRole('dialog', { name: 'Notifications' });

      expect(container).not.toContainElement(dialog);
      expect(dialog).toHaveClass(styles.panel, styles.panelMobile);

      await userEvent.click(within(dialog).getByRole('button', { name: 'Close notifications' }));
      expect(onClose).toHaveBeenCalledTimes(1);

      const backdrop = dialog.previousElementSibling as HTMLElement;
      expect(backdrop).toHaveClass(styles.mobileOverlay);
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('closes once when the backdrop gets a real pointer click', async () => {
      setMobile(true);
      seedStore();
      const { onClose } = renderPanel();

      await userEvent.click(screen.getByRole('dialog').previousElementSibling as HTMLElement);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('fades the backdrop out while closing', () => {
      setMobile(true);
      seedStore();
      const { rerender, onClose } = renderPanel();

      rerender(<NotificationPanel isOpen={false} onClose={onClose} />);
      expect(screen.getByRole('dialog').previousElementSibling).toHaveClass(
        styles.mobileOverlayClosing
      );
    });

    it('follows viewport resizes', () => {
      seedStore();
      renderPanel();
      expect(screen.queryByRole('button', { name: 'Close notifications' })).toBeNull();

      setMobile(true);
      resize();
      expect(screen.getByRole('button', { name: 'Close notifications' })).toBeInTheDocument();

      setMobile(false);
      resize();
      expect(screen.queryByRole('button', { name: 'Close notifications' })).toBeNull();
    });
  });

  it('closes on the system Back action', async () => {
    seedStore();
    const { onClose } = renderPanel();

    await waitFor(() =>
      expect(window.history.state).toEqual(
        expect.objectContaining({ __overlayId: expect.any(String) })
      )
    );
    act(() => window.history.back());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
