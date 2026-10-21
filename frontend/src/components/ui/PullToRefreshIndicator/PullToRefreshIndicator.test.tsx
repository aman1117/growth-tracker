import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PullToRefreshState } from '../../../hooks/usePullToRefresh';
import { PullToRefreshIndicator } from './index';
import styles from './PullToRefreshIndicator.module.css';

interface FakeAnimation {
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
}

const indicator = (state: PullToRefreshState, pullOffset = 0, className?: string) => (
  <PullToRefreshIndicator
    state={state}
    pullOffset={pullOffset}
    threshold={36}
    className={className}
  />
);

describe('PullToRefreshIndicator', () => {
  let animations: FakeAnimation[];
  let animate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom does not implement the Web Animations API
    animations = [];
    animate = vi.fn(() => {
      const animation: FakeAnimation = { cancel: vi.fn(), onfinish: null };
      animations.push(animation);
      return animation;
    });
    Element.prototype.animate = animate as unknown as Element['animate'];
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'animate');
  });

  it('renders nothing while idle', () => {
    const { container } = render(indicator('idle'));
    expect(container).toBeEmptyDOMElement();
  });

  it('follows the pull with an arrow that turns towards the threshold', () => {
    render(indicator('pulling', 18, 'feed-ptr'));
    const status = screen.getByRole('status', { name: 'Pull down to refresh' });
    const arrow = status.querySelector('svg') as SVGElement;

    expect(status).toHaveClass(styles.container, 'feed-ptr');
    // Never above its resting spot while the pull is still short
    expect(status.style.transform).toBe('translateY(0px)');
    expect(arrow.style.transform).toBe('rotate(90deg)');
    expect(status.querySelector(`.${styles.puck}`)).not.toHaveClass(styles.armed);
    expect(status.querySelector(`.${styles.spinner}`)).not.toBeInTheDocument();
  });

  it('moves down with longer pulls', () => {
    render(indicator('pulling', 30));
    expect(screen.getByRole('status').style.transform).toBe('translateY(6px)');
  });

  it('asks to release once armed, with the arrow fully turned', () => {
    render(indicator('armed', 50));
    const status = screen.getByRole('status', { name: 'Release to refresh' });

    expect(status.querySelector(`.${styles.puck}`)).toHaveClass(styles.armed);
    expect((status.querySelector('svg') as SVGElement).style.transform).toBe('rotate(180deg)');
    expect(status.style.transform).toBe('translateY(26px)');
  });

  it('shows a spinner at a fixed position while refreshing', () => {
    render(indicator('refreshing', 36));
    const status = screen.getByRole('status', { name: 'Refreshing content' });

    expect(status.style.transform).toBe('translateY(16px)');
    expect(status.querySelector(`.${styles.puck}`)).toHaveClass(styles.armed);
    expect(status.querySelector(`.${styles.spinner}`)).toHaveClass(styles.spinning);
  });

  it('slides out from where it is when settling', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 60,
    } as DOMRect);
    const { rerender } = render(indicator('refreshing', 36));

    const computedStyle = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({ top: '20px' } as CSSStyleDeclaration);
    rerender(indicator('settling'));
    computedStyle.mockRestore();

    const status = screen.getByRole('status', { name: 'Pull down to refresh' });
    // The Web Animations API owns the transform while settling
    expect(status.style.transform).toBe('');
    expect(animate).toHaveBeenCalledExactlyOnceWith(
      [
        { transform: 'translateY(40px)', opacity: 1 },
        { transform: 'translateY(-40px)', opacity: 0 },
      ],
      { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
    );
    expect(animate.mock.contexts[0]).toBe(status);
  });

  it('starts from its anchor when no offset can be measured', () => {
    const { rerender } = render(indicator('pulling', 10));
    rerender(indicator('settling'));

    expect(animate.mock.calls[0][0][0]).toEqual({ transform: 'translateY(0px)', opacity: 1 });
  });

  it('cancels an unfinished slide-out when it disappears', () => {
    const { rerender } = render(indicator('pulling', 10));
    rerender(indicator('settling'));

    rerender(indicator('idle'));

    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not cancel a slide-out that already finished, and can slide out again', () => {
    const { rerender } = render(indicator('pulling', 10));
    rerender(indicator('settling'));
    animations[0].onfinish?.();

    rerender(indicator('pulling', 20));
    rerender(indicator('settling'));

    expect(animations[0].cancel).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(2);
  });
});
