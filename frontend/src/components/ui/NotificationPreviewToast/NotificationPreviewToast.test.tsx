import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeNotification } from '../../../test/fixtures/ui';
import type { Notification } from '../../../types';
import tones from '../Notification/NotificationTone.module.css';
import {
  NotificationPreviewToast,
  type NotificationPreviewToastProps,
} from './NotificationPreviewToast';
import styles from './NotificationPreviewToast.module.css';

function renderToast(
  props: Partial<NotificationPreviewToastProps> = {},
  notification: Notification = makeNotification()
) {
  const onClose = vi.fn();
  const onClick = vi.fn();
  const utils = render(
    <NotificationPreviewToast
      notification={notification}
      onClose={onClose}
      onClick={onClick}
      {...props}
    />
  );
  return { onClose, onClick, notification, toast: screen.getByRole('status'), ...utils };
}

const touch = (clientY: number, clientX = 0) => ({ touches: [{ clientX, clientY }] });
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('NotificationPreviewToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // jsdom has no Vibration API; remove the one a test may have added
    Reflect.deleteProperty(navigator, 'vibrate');
  });

  it('shows the title, body and type icon in a polite status portal', () => {
    const { toast, container } = renderToast();

    expect(toast).toHaveAttribute('aria-live', 'polite');
    expect(toast).toHaveClass(styles.previewToast);
    expect(toast).toHaveTextContent('New like');
    expect(toast).toHaveTextContent('alice liked your day');
    expect(toast.querySelector(`.${styles.iconWrapper}`)).toHaveClass(tones.like);
    expect(toast.querySelector('.lucide-heart')).toBeInTheDocument();
    expect(container).not.toContainElement(toast);
  });

  it('uses the icon and tone of the notification type', () => {
    const { toast } = renderToast({}, makeNotification({ type: 'new_follower', metadata: null }));

    expect(toast.querySelector(`.${styles.iconWrapper}`)).toHaveClass(tones.follow);
    expect(toast.querySelector('.lucide-user-plus')).toBeInTheDocument();
  });

  it('omits an empty body', () => {
    const { toast } = renderToast({}, makeNotification({ body: '' }));
    expect(toast.querySelector(`.${styles.body}`)).not.toBeInTheDocument();
  });

  it('vibrates once on arrival when the device supports it', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });

    renderToast();

    expect(vibrate).toHaveBeenCalledExactlyOnceWith(100);
  });

  it('works on devices without vibration', () => {
    expect('vibrate' in navigator).toBe(false);
    expect(() => renderToast()).not.toThrow();
  });

  it('dismisses itself after 5 seconds with an exit animation', () => {
    const { toast, onClose } = renderToast();

    advance(4999);
    expect(toast).not.toHaveClass(styles.exiting);
    advance(1);
    expect(toast).toHaveClass(styles.exiting);
    expect(onClose).not.toHaveBeenCalled();

    advance(250);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports a custom duration or staying until dismissed', () => {
    const { onClose, unmount } = renderToast({ duration: 1000 });
    advance(1250);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    const { onClose: onCloseSticky } = renderToast({ duration: 0 });
    advance(60_000);
    expect(onCloseSticky).not.toHaveBeenCalled();
  });

  it('opens the notification and closes when clicked', () => {
    const { toast, onClick, onClose, notification } = renderToast();

    fireEvent.click(screen.getByText('alice liked your day'));

    expect(onClick).toHaveBeenCalledExactlyOnceWith(notification);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveClass(styles.exiting);
  });

  it('dismisses from the close button without opening the notification', () => {
    const { toast, onClick, onClose } = renderToast();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(toast).toHaveClass(styles.exiting);
    expect(onClick).not.toHaveBeenCalled();

    advance(250);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses on Escape only', () => {
    const { onClose } = renderToast();

    fireEvent.keyDown(document, { key: 'Enter' });
    advance(300);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    advance(250);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stops listening for Escape and timers once unmounted', () => {
    const { onClose, unmount } = renderToast();

    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    advance(10_000);
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('swipe to dismiss', () => {
    it('follows an upward swipe and springs back when released early', () => {
      const { toast, onClose } = renderToast();

      fireEvent.touchStart(toast, touch(100));
      fireEvent.touchMove(toast, touch(80));
      expect(toast).toHaveClass(styles.dragging);
      expect(toast.style.transform).toBe('translateX(-50%) translateY(-20px)');
      expect(toast.style.opacity).toBe('0.8');
      expect(toast.style.transition).toBe('none');

      fireEvent.touchEnd(toast);
      expect(onClose).not.toHaveBeenCalled();
      expect(toast).not.toHaveClass(styles.dragging);
      expect(toast.style.transform).toBe('');
    });

    it('closes immediately when swiped past the threshold', () => {
      const { toast, onClose, onClick } = renderToast();

      fireEvent.touchStart(toast, touch(200));
      fireEvent.touchMove(toast, touch(20));
      expect(toast.style.transform).toBe('translateX(-50%) translateY(-100px)');
      expect(toast.style.opacity).toBe('0');

      fireEvent.touchEnd(toast);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it('ignores downward, sideways and stray moves', () => {
      const { toast, onClose } = renderToast();

      fireEvent.touchMove(toast, touch(10));
      expect(toast).not.toHaveClass(styles.dragging);

      fireEvent.touchStart(toast, touch(100));
      fireEvent.touchMove(toast, touch(160));
      fireEvent.touchMove(toast, touch(60, 90));
      expect(toast.style.transform).toBe('translateX(-50%) translateY(-0px)');

      fireEvent.touchEnd(toast);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('stops the page from scrolling only while dragging', () => {
      const { toast } = renderToast();

      expect(fireEvent.touchMove(toast, touch(90))).toBe(true);
      fireEvent.touchStart(toast, touch(100));
      expect(fireEvent.touchMove(toast, touch(90))).toBe(false);
    });
  });
});
