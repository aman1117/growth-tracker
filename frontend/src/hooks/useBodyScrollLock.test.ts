import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import useBodyScrollLockDefault, { lockBodyScroll, useBodyScrollLock } from './useBodyScrollLock';

const bodyStyle = () => ({
  overflow: document.body.style.overflow,
  touchAction: document.body.style.touchAction,
});

describe('useBodyScrollLock', () => {
  it('locks page scrolling while active and restores the previous value', () => {
    document.body.style.overflow = 'scroll';
    const { rerender } = renderHook(({ locked }) => useBodyScrollLock(locked), {
      initialProps: { locked: true },
    });

    expect(bodyStyle()).toEqual({ overflow: 'hidden', touchAction: '' });

    rerender({ locked: false });
    expect(bodyStyle()).toEqual({ overflow: 'scroll', touchAction: '' });
  });

  it('does nothing while inactive', () => {
    renderHook(() => useBodyScrollLock(false, { blockTouch: true }));

    expect(bodyStyle()).toEqual({ overflow: '', touchAction: '' });
  });

  it('can also block touch gestures', () => {
    const { unmount } = renderHook(() => useBodyScrollLock(true, { blockTouch: true }));

    expect(bodyStyle()).toEqual({ overflow: 'hidden', touchAction: 'none' });

    unmount();
    expect(bodyStyle()).toEqual({ overflow: '', touchAction: '' });
  });

  it('keeps the page locked until the last of several overlays closes', () => {
    const sheet = renderHook(() => useBodyScrollLock(true));
    const viewer = renderHook(() => useBodyScrollLock(true, { blockTouch: true }));

    sheet.unmount();
    expect(bodyStyle()).toEqual({ overflow: 'hidden', touchAction: 'none' });

    viewer.unmount();
    expect(bodyStyle()).toEqual({ overflow: '', touchAction: '' });
  });

  it('is also the default export', () => {
    expect(useBodyScrollLockDefault).toBe(useBodyScrollLock);
  });
});

describe('lockBodyScroll', () => {
  it('returns an idempotent release function', () => {
    const releaseFirst = lockBodyScroll();
    const releaseSecond = lockBodyScroll();

    releaseFirst();
    releaseFirst();
    expect(bodyStyle().overflow).toBe('hidden');

    releaseSecond();
    expect(bodyStyle().overflow).toBe('');
  });
});
