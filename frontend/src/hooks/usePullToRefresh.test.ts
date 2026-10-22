import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMatchMedia } from '../test/utils';
import usePullToRefreshDefault, {
  usePullToRefresh,
  type UsePullToRefreshOptions,
} from './usePullToRefresh';

function renderPull(options: Partial<UsePullToRefreshOptions> = {}) {
  const onRefresh = options.onRefresh ?? vi.fn().mockResolvedValue(undefined);
  const hook = renderHook((props: UsePullToRefreshOptions) => usePullToRefresh(props), {
    initialProps: { ...options, onRefresh },
  });
  return { ...hook, onRefresh };
}

const fingers = (clientY: number, clientX = 0, count = 1) =>
  Array.from({ length: count }, () => ({ clientX, clientY }));

/** Each helper returns false when the hook called preventDefault() (blocking native overscroll). */
const touch = {
  start: (y: number, x = 0, count = 1) =>
    fireEvent.touchStart(document, { touches: fingers(y, x, count) }),
  move: (y: number, x = 0, count = 1) =>
    fireEvent.touchMove(document, { touches: fingers(y, x, count) }),
  end: () => fireEvent.touchEnd(document, { touches: [] }),
  cancel: () => fireEvent.touchCancel(document, { touches: [] }),
};

const mouse = (init: PointerEventInit = {}) => ({
  pointerType: 'mouse',
  isPrimary: true,
  button: 0,
  clientX: 0,
  ...init,
});
const pointer = {
  down: (y: number, init?: PointerEventInit) =>
    fireEvent.pointerDown(document, mouse({ clientY: y, ...init })),
  move: (y: number, init?: PointerEventInit) =>
    fireEvent.pointerMove(document, mouse({ clientY: y, ...init })),
  up: (init?: PointerEventInit) => fireEvent.pointerUp(document, mouse(init)),
  cancel: () => fireEvent.pointerCancel(document, mouse()),
};

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

afterEach(() => {
  Reflect.deleteProperty(navigator, 'vibrate');
});

describe('usePullToRefresh', () => {
  it('starts idle', () => {
    const { result } = renderPull();

    expect(result.current).toEqual({
      state: 'idle',
      isPulling: false,
      isArmed: false,
      isRefreshing: false,
      pullOffset: 0,
      isSettling: false,
    });
  });

  it('follows the finger with resistance and blocks native overscroll', () => {
    const { result } = renderPull();

    touch.start(100);
    const notPrevented = touch.move(140);

    expect(notPrevented).toBe(false);
    expect(result.current).toMatchObject({
      state: 'pulling',
      isPulling: true,
      isArmed: false,
      pullOffset: 20,
    });
  });

  it('snaps back without refreshing when released before the threshold', async () => {
    vi.useFakeTimers();
    const { result, onRefresh } = renderPull();
    touch.start(100);
    touch.move(140);

    touch.end();

    expect(result.current).toMatchObject({ state: 'settling', isSettling: true, pullOffset: 0 });
    await advance(199);
    expect(result.current.state).toBe('settling');
    await advance(1);
    expect(result.current.state).toBe('idle');
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('arms past the threshold with a single haptic tick and clamps the pull distance', () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    const { result } = renderPull();
    touch.start(0);

    touch.move(80);
    expect(result.current).toMatchObject({ state: 'armed', isArmed: true, pullOffset: 40 });

    touch.move(50);
    expect(result.current).toMatchObject({ state: 'pulling', isArmed: false });

    touch.move(400);
    expect(result.current).toMatchObject({ state: 'armed', pullOffset: 70 });

    touch.move(120);
    expect(result.current).toMatchObject({ state: 'armed', pullOffset: 60 });
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it('survives browsers that block vibration', () => {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        throw new Error('Blocked');
      },
    });
    const { result } = renderPull();
    touch.start(0);

    touch.move(100);

    expect(result.current.state).toBe('armed');
  });

  it('refreshes when released while armed and shows the spinner for at least 300ms', async () => {
    vi.useFakeTimers();
    const { result, onRefresh } = renderPull();
    touch.start(0);
    touch.move(100);

    touch.end();

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({
      state: 'refreshing',
      isRefreshing: true,
      pullOffset: 36,
    });
    await advance(299);
    expect(result.current.state).toBe('refreshing');
    await advance(1);
    expect(result.current).toMatchObject({ state: 'settling', pullOffset: 0 });
    await advance(200);
    expect(result.current.state).toBe('idle');
  });

  it('settles right away when the refresh itself took longer than the minimum', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
    const { result } = renderPull({ onRefresh });
    touch.start(0);
    touch.move(100);
    touch.end();

    await advance(1000);

    expect(result.current.state).toBe('settling');
  });

  it('logs a failed refresh and still settles', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('Network down');
    const { result } = renderPull({ onRefresh: vi.fn().mockRejectedValue(failure) });
    touch.start(0);
    touch.move(100);
    touch.end();

    await advance(300);

    expect(consoleError).toHaveBeenCalledWith('[PullToRefresh] Refresh failed:', failure);
    expect(result.current.state).toBe('settling');
  });

  it('ignores new pulls while refreshing', async () => {
    vi.useFakeTimers();
    let finishRefresh!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => (finishRefresh = resolve)));
    const { result } = renderPull({ onRefresh });
    touch.start(0);
    touch.move(100);
    touch.end();

    touch.start(0);
    touch.move(120);
    touch.end();

    expect(result.current).toMatchObject({ state: 'refreshing', pullOffset: 36 });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => finishRefresh());
  });

  it('honours custom threshold, resistance and spinner time', async () => {
    vi.useFakeTimers();
    const { result } = renderPull({ threshold: 40, resistanceFactor: 1, minSpinnerTime: 0 });
    touch.start(0);

    touch.move(40);
    expect(result.current).toMatchObject({ state: 'armed', pullOffset: 40 });

    touch.end();
    await advance(0);
    expect(result.current.state).toBe('settling');
  });

  it('settles instantly for users who prefer reduced motion', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      createMatchMedia((query) => query.includes('reduce'))
    );
    const { result } = renderPull();
    touch.start(0);
    touch.move(30);
    touch.end();

    await advance(0);

    expect(result.current.state).toBe('idle');
  });

  describe('gestures that must not refresh', () => {
    it.each([9, 300])('ignores pulls that start below the top (scrollY %i)', (scrollY) => {
      vi.stubGlobal('scrollY', scrollY);
      const { result } = renderPull();

      touch.start(0);
      expect(touch.move(100)).toBe(true);
      touch.end();

      expect(result.current.state).toBe('idle');
    });

    it('accepts pulls within the 8px scroll tolerance', () => {
      vi.stubGlobal('scrollY', 8);
      const { result } = renderPull();

      touch.start(0);
      touch.move(40);

      expect(result.current.state).toBe('pulling');
    });

    it('cancels the gesture when the finger moves up', () => {
      const { result } = renderPull();
      touch.start(100);

      expect(touch.move(90)).toBe(true);
      touch.move(250);

      expect(result.current.state).toBe('idle');
    });

    it('cancels the gesture on a horizontal swipe', () => {
      const { result } = renderPull();
      touch.start(100, 100);

      touch.move(105, 130);
      touch.move(250, 130);

      expect(result.current.state).toBe('idle');
    });

    it.each([
      ['moves back up', () => touch.move(-10)],
      ['swipes sideways', () => touch.move(45, 80)],
      [
        'scrolls the page away',
        () => {
          vi.stubGlobal('scrollY', 50);
          return touch.move(50);
        },
      ],
      ['is interrupted by the system', () => touch.cancel()],
    ])('snaps back when a pulling finger %s', (_label, interrupt) => {
      const { result, onRefresh } = renderPull();
      touch.start(0);
      touch.move(40);

      interrupt();
      touch.end();

      expect(result.current).toMatchObject({ state: 'settling', pullOffset: 0 });
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('ignores multi-finger gestures', () => {
      const { result } = renderPull();

      touch.start(0, 0, 2);
      touch.move(100, 0, 2);
      touch.start(0);
      touch.move(100, 0, 2);

      expect(result.current.state).toBe('idle');
    });

    it('stays idle when an untouched gesture is cancelled or ends', () => {
      const { result, onRefresh } = renderPull();

      touch.cancel();
      touch.start(0);
      touch.end();

      expect(result.current.state).toBe('idle');
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('does nothing while disabled', () => {
      const { result } = renderPull({ disabled: true });

      touch.start(0);
      touch.move(120);
      touch.end();
      pointer.down(0);
      pointer.move(120);

      expect(result.current.state).toBe('idle');
    });
  });

  describe('mouse (pointer events)', () => {
    it('refreshes with a mouse drag', async () => {
      // Fake timers: the spinner's minimum time must not outlive the test as a real timer
      vi.useFakeTimers();
      const { result, onRefresh } = renderPull();

      pointer.down(0);
      pointer.move(100);
      expect(result.current.state).toBe('armed');

      pointer.up();
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(result.current.state).toBe('refreshing');

      await advance(300);
      expect(result.current.state).toBe('settling');
    });

    it.each([
      ['touch pointers (handled by touch events)', { pointerType: 'touch' }],
      ['secondary mouse buttons', { button: 2 }],
      ['non-primary pointers', { isPrimary: false }],
    ])('ignores %s', (_label, init) => {
      const { result } = renderPull();

      pointer.down(0, init);
      pointer.move(100);

      expect(result.current.state).toBe('idle');
    });

    it('ignores moves and releases from other pointers', () => {
      const { result, onRefresh } = renderPull();
      pointer.down(0);
      pointer.move(100);

      pointer.move(10, { isPrimary: false });
      pointer.move(10, { pointerType: 'touch' });
      pointer.up({ isPrimary: false });
      pointer.up({ pointerType: 'touch' });

      expect(result.current.state).toBe('armed');
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('snaps back when the pointer is cancelled', () => {
      const { result } = renderPull();
      pointer.down(0);
      pointer.move(40);

      pointer.cancel();

      expect(result.current.state).toBe('settling');
    });
  });

  it('removes its listeners and timers on unmount', () => {
    vi.useFakeTimers();
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderPull();
    touch.start(0);
    touch.move(40);
    touch.end();

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove'].forEach(
      (type) => expect(removeListener).toHaveBeenCalledWith(type, expect.any(Function))
    );
  });

  it('uses only pointer events on devices without touch support', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'ontouchstart');
    Reflect.deleteProperty(window, 'ontouchstart');
    try {
      expect('ontouchstart' in window).toBe(false);
      const { result } = renderPull();

      touch.start(0);
      touch.move(100);
      expect(result.current.state).toBe('idle');

      pointer.down(0);
      pointer.move(100);
      expect(result.current.state).toBe('armed');
    } finally {
      if (descriptor) Object.defineProperty(window, 'ontouchstart', descriptor);
    }
  });

  it('is also the default export', () => {
    expect(usePullToRefreshDefault).toBe(usePullToRefresh);
  });
});
