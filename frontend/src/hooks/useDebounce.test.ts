import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebounce } from './useDebounce';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('useDebounce', () => {
  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('alice'));

    expect(result.current).toBe('alice');
  });

  it('publishes a new value only after the default 300ms of quiet', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'al' });
    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe('a');

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('al');
  });

  it('restarts the wait on every change so only the last value is published', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 500), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'al' });
    act(() => vi.advanceTimersByTime(400));
    rerender({ value: 'ali' });
    act(() => vi.advanceTimersByTime(400));
    expect(result.current).toBe('a');

    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe('ali');
  });

  it('cancels the pending update on unmount', () => {
    const { rerender, unmount } = renderHook(({ value }) => useDebounce(value), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'ab' });

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
