import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRefreshOnFocus } from './useRefreshOnFocus';

const NOW = new Date('2026-10-22T06:30:00Z').getTime();

let visibility: DocumentVisibilityState = 'visible';

const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
};

const focusWindow = () => window.dispatchEvent(new Event('focus'));

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe('useRefreshOnFocus', () => {
  beforeEach(() => {
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes when the page becomes visible again', () => {
    const onRefresh = vi.fn();
    renderHook(() => useRefreshOnFocus(onRefresh));

    setVisibility('hidden');
    expect(onRefresh).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the window regains focus', () => {
    const onRefresh = vi.fn();
    renderHook(() => useRefreshOnFocus(onRefresh));

    focusWindow();

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('merges a visibility change and a focus that arrive together', () => {
    const onRefresh = vi.fn();
    renderHook(() => useRefreshOnFocus(onRefresh, { minIntervalMs: 1000 }));

    setVisibility('visible');
    focusWindow();
    later(999);
    focusWindow();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    later(1);
    focusWindow();
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('refreshes again after the clock went backwards', () => {
    const onRefresh = vi.fn();
    renderHook(() => useRefreshOnFocus(onRefresh));

    focusWindow();
    later(-5000);
    focusWindow();

    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('ignores focus while the page is hidden', () => {
    const onRefresh = vi.fn();
    renderHook(() => useRefreshOnFocus(onRefresh));

    visibility = 'hidden';
    focusWindow();

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does nothing while disabled', () => {
    const onRefresh = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useRefreshOnFocus(onRefresh, { enabled }), {
      initialProps: { enabled: false },
    });

    focusWindow();
    expect(onRefresh).not.toHaveBeenCalled();

    rerender({ enabled: true });
    focusWindow();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('calls the latest callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ onRefresh }) => useRefreshOnFocus(onRefresh), {
      initialProps: { onRefresh: first },
    });

    rerender({ onRefresh: second });
    focusWindow();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops listening when unmounted', () => {
    const onRefresh = vi.fn();
    const { unmount } = renderHook(() => useRefreshOnFocus(onRefresh));

    unmount();
    focusWindow();
    setVisibility('visible');

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
