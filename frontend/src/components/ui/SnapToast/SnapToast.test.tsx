import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SnapToast, type SnapToastProps, type SnapToastType } from './SnapToast';
import styles from './SnapToast.module.css';

function renderToast(props: Partial<SnapToastProps> = {}) {
  const onClose = vi.fn();
  const utils = render(<SnapToast message="Saved" onClose={onClose} {...props} />);
  const toast = screen.getByText(props.message ?? 'Saved').parentElement as HTMLElement;
  return { onClose, toast, ...utils };
}

const touch = (clientY: number, clientX = 0) => ({ touches: [{ clientX, clientY }] });

/** Drags the toast vertically from `fromY` to `toY` without releasing. */
function drag(toast: HTMLElement, fromY: number, toY: number, toX = 0) {
  fireEvent.touchStart(toast, touch(fromY));
  fireEvent.touchMove(toast, touch(toY, toX));
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('SnapToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('shows the message at the top as a polite status, rendered in a portal', () => {
    const { toast, container } = renderToast();

    expect(screen.getByRole('status')).toBe(toast);
    expect(toast).toHaveAttribute('aria-live', 'polite');
    expect(toast).toHaveClass(styles.snapToast, styles.neutral, styles.top);
    expect(toast).not.toHaveClass(styles.exiting);
    expect(toast.querySelector(`.${styles.iconWrapper} .lucide-zap`)).toBeInTheDocument();
    expect(container).not.toContainElement(toast);
  });

  it.each<[SnapToastType, string, string]>([
    ['success', 'status', 'lucide-check'],
    ['info', 'status', 'lucide-info'],
    ['neutral', 'status', 'lucide-zap'],
    ['error', 'alert', 'lucide-x'],
  ])('renders the %s type as a %s with its icon', (type, role, iconClass) => {
    const { toast } = renderToast({ type });

    expect(screen.getByRole(role)).toBe(toast);
    expect(toast).toHaveClass(styles[type]);
    expect(toast.querySelector(`.${iconClass}`)).toBeInTheDocument();
  });

  it('announces warnings assertively', () => {
    const { toast } = renderToast({ type: 'warning' });

    expect(screen.getByRole('alert')).toBe(toast);
    expect(toast).toHaveAttribute('aria-live', 'assertive');
    expect(toast).toHaveClass(styles.warning);
    expect(toast.querySelector(`.${styles.iconWrapper} svg`)).toBeInTheDocument();
  });

  it('supports a custom icon, no icon and the bottom position', () => {
    const { toast, unmount } = renderToast({
      icon: <svg data-icon="custom" />,
      position: 'bottom',
    });
    expect(toast.querySelector('[data-icon="custom"]')).toBeInTheDocument();
    expect(toast.querySelector('.lucide-zap')).not.toBeInTheDocument();
    expect(toast).toHaveClass(styles.bottom);
    unmount();

    const { toast: plain } = renderToast({ showIcon: false });
    expect(plain.querySelector(`.${styles.iconWrapper}`)).not.toBeInTheDocument();
  });

  it('dismisses itself after the default 2.5s, after an exit animation', () => {
    const { toast, onClose } = renderToast();

    advance(2499);
    expect(toast).not.toHaveClass(styles.exiting);

    advance(1);
    expect(toast).toHaveClass(styles.exiting);
    advance(249);
    expect(onClose).not.toHaveBeenCalled();

    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports a custom duration', () => {
    const { onClose } = renderToast({ duration: 1000 });

    advance(1250);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays until closed when the duration is zero, without a progress bar', () => {
    const { toast, onClose } = renderToast({ duration: 0, showProgress: true });

    advance(60_000);
    expect(onClose).not.toHaveBeenCalled();
    expect(toast.querySelector(`.${styles.progressBar}`)).not.toBeInTheDocument();
  });

  it('shows a progress bar matching the duration', () => {
    const { toast } = renderToast({ showProgress: true, duration: 4000 });

    expect(toast.querySelector<HTMLElement>(`.${styles.progressBar}`)).toHaveStyle({
      animationDuration: '4000ms',
    });
  });

  it('cancels the auto-dismiss when unmounted', () => {
    const { onClose, unmount } = renderToast();

    unmount();
    advance(5000);
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('swipe to dismiss', () => {
    it('follows the finger upwards and fades out', () => {
      const { toast } = renderToast();

      drag(toast, 100, 80);

      expect(toast).toHaveClass(styles.dragging);
      expect(toast.style.transform).toBe('translateX(-50%) translateY(-20px)');
      expect(toast.style.opacity).toBe('0.8');
      expect(toast.style.transition).toBe('none');
    });

    it('springs back when released before the threshold', () => {
      const { toast, onClose } = renderToast();

      drag(toast, 100, 75);
      fireEvent.touchEnd(toast);

      expect(onClose).not.toHaveBeenCalled();
      expect(toast).not.toHaveClass(styles.dragging);
      expect(toast.style.transform).toBe('');
    });

    it('closes immediately when swiped up past the threshold', () => {
      const { toast, onClose } = renderToast();

      drag(toast, 100, 40);
      expect(toast.style.opacity).toBe('0');
      expect(toast.style.transform).toBe('translateX(-50%) translateY(-100px)');

      fireEvent.touchEnd(toast);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('swipes down to dismiss a bottom toast and ignores upward drags', () => {
      const { toast, onClose } = renderToast({ position: 'bottom' });

      drag(toast, 100, 60);
      expect(toast.style.transform).toBe('translateX(-50%) translateY(0px)');

      fireEvent.touchMove(toast, touch(150));
      expect(toast.style.transform).toBe('translateX(-50%) translateY(100px)');
      fireEvent.touchEnd(toast);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('ignores mostly horizontal swipes', () => {
      const { toast, onClose } = renderToast();

      drag(toast, 100, 60, 80);
      fireEvent.touchEnd(toast);

      expect(onClose).not.toHaveBeenCalled();
    });

    it('ignores moves without a touch start', () => {
      const { toast } = renderToast();

      fireEvent.touchMove(toast, touch(10));
      expect(toast).not.toHaveClass(styles.dragging);
      expect(toast.style.transform).toBe('');
    });

    it('stops the page from scrolling only while dragging', () => {
      const { toast } = renderToast();

      expect(fireEvent.touchMove(toast, touch(90))).toBe(true);
      fireEvent.touchStart(toast, touch(100));
      expect(fireEvent.touchMove(toast, touch(90))).toBe(false);
    });

    it('can be disabled', () => {
      const { toast, onClose } = renderToast({ swipeable: false });

      drag(toast, 100, 20);
      fireEvent.touchEnd(toast);

      expect(toast).not.toHaveClass(styles.dragging);
      expect(onClose).not.toHaveBeenCalled();
      expect(fireEvent.touchMove(toast, touch(10))).toBe(true);
    });
  });
});
