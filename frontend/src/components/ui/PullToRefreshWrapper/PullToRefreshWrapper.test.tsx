import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '../../../test/fixtures/ui';
import { PullToRefreshWrapper, type PullToRefreshWrapperProps } from './index';

interface FakeAnimation {
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
}

const touch = (clientY: number, clientX = 0) => ({ touches: [{ clientX, clientY }] });

/** Drags a finger down the page from the top by `distance` px (without lifting it). */
function pull(distance: number) {
  fireEvent.touchStart(document, touch(0));
  fireEvent.touchMove(document, touch(distance));
}

const release = () => fireEvent.touchEnd(document);
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function renderWrapper(props: Partial<PullToRefreshWrapperProps> = {}) {
  const refresh = createDeferred<void>();
  const onRefresh = vi.fn(() => refresh.promise);
  const utils = render(
    <PullToRefreshWrapper onRefresh={onRefresh} {...props}>
      <p>Feed content</p>
    </PullToRefreshWrapper>
  );
  const content = screen.getByText('Feed content').parentElement as HTMLElement;
  const wrapper = content.parentElement as HTMLElement;
  return { onRefresh, refresh, content, wrapper, ...utils };
}

describe('PullToRefreshWrapper', () => {
  let animations: FakeAnimation[];
  let animate: ReturnType<typeof vi.fn>;
  let contentOffset: number;

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom implements neither the Web Animations API nor DOMMatrix
    animations = [];
    animate = vi.fn(() => {
      const animation: FakeAnimation = { cancel: vi.fn(), onfinish: null };
      animations.push(animation);
      return animation;
    });
    Element.prototype.animate = animate as unknown as Element['animate'];
    contentOffset = 0;
    vi.stubGlobal(
      'DOMMatrix',
      class {
        readonly m42 = contentOffset;
      }
    );
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'animate');
  });

  it('renders its content at rest', () => {
    const { content, wrapper } = renderWrapper();

    expect(wrapper).toHaveAttribute('aria-busy', 'false');
    expect(wrapper).toHaveAttribute('aria-live', 'polite');
    expect(content.style.transform).toBe('');
    expect(content.style.willChange).toBe('');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('moves the content with the finger (with resistance) while pulling', () => {
    const { content } = renderWrapper();

    pull(40);

    expect(screen.getByRole('status', { name: 'Pull down to refresh' })).toBeInTheDocument();
    expect(content.style.transform).toBe('translateY(20px)');
    expect(content.style.willChange).toBe('transform');
  });

  it('asks to release once pulled past the threshold', () => {
    const { content } = renderWrapper();

    pull(100);

    expect(screen.getByRole('status', { name: 'Release to refresh' })).toBeInTheDocument();
    expect(content.style.transform).toBe('translateY(50px)');
  });

  it('refreshes on release, holds the spinner, then settles back', async () => {
    const { content, wrapper, onRefresh, refresh } = renderWrapper();

    pull(100);
    release();

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(wrapper).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status', { name: 'Refreshing content' })).toBeInTheDocument();
    expect(content.style.transform).toBe('translateY(36px)');

    await act(async () => refresh.resolve());
    // The spinner stays up for a minimum time to avoid flicker
    expect(wrapper).toHaveAttribute('aria-busy', 'true');
    await advance(300);

    expect(wrapper).toHaveAttribute('aria-busy', 'false');
    expect(content.style.transform).toBe('');
    await advance(200);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(content.style.transform).toBe('');
  });

  it('animates the content back from its current offset when settling', async () => {
    const { content, refresh } = renderWrapper();
    pull(100);
    release();
    contentOffset = 36;

    await act(async () => refresh.resolve());
    await advance(300);

    const contentAnimation = animate.mock.contexts.indexOf(content);
    expect(contentAnimation).toBeGreaterThanOrEqual(0);
    expect(animate.mock.calls[contentAnimation]).toEqual([
      [{ transform: 'translateY(36px)' }, { transform: 'translateY(0)' }],
      { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    ]);

    content.style.transform = 'translateY(36px)';
    animations[contentAnimation].onfinish?.();
    expect(content.style.transform).toBe('');
  });

  it('cancels the settle animation when unmounted mid-way', async () => {
    const { content, refresh, unmount } = renderWrapper();
    pull(100);
    release();
    contentOffset = 36;
    await act(async () => refresh.resolve());
    await advance(300);
    const contentAnimation = animations[animate.mock.contexts.indexOf(content)];

    unmount();

    expect(contentAnimation.cancel).toHaveBeenCalledTimes(1);
  });

  it('snaps back without refreshing when released before the threshold', async () => {
    const { onRefresh } = renderWrapper();

    pull(40);
    release();
    await advance(200);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('still settles when the refresh fails', async () => {
    const error = new Error('offline');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { wrapper, refresh } = renderWrapper();

    pull(100);
    release();
    await act(async () => refresh.reject(error));
    await advance(500);

    expect(consoleError).toHaveBeenCalledWith('[PullToRefresh] Refresh failed:', error);
    expect(wrapper).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('ignores pulls while disabled', () => {
    const { onRefresh, content } = renderWrapper({ disabled: true });

    pull(100);
    release();

    expect(onRefresh).not.toHaveBeenCalled();
    expect(content.style.transform).toBe('');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('uses custom thresholds and classes', () => {
    const { wrapper } = renderWrapper({ threshold: 120, maxPull: 200, className: 'feed' });

    pull(100);
    expect(screen.getByRole('status', { name: 'Pull down to refresh' })).toBeInTheDocument();
    expect(wrapper).toHaveClass('feed');

    fireEvent.touchMove(document, touch(180));
    expect(screen.getByRole('status', { name: 'Release to refresh' })).toBeInTheDocument();
  });
});
