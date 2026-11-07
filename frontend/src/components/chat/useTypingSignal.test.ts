import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TYPING_SEND_INTERVAL_MS } from '../../utils/chat';
import { useTypingSignal } from './useTypingSignal';

describe('useTypingSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 8, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says "typing" at most every few seconds and "stopped" once', () => {
    const send = vi.fn();
    const { result, unmount } = renderHook(() => useTypingSignal(send));

    result.current.onTextChange('H');
    result.current.onTextChange('He');
    expect(send).toHaveBeenCalledExactlyOnceWith(true);

    vi.advanceTimersByTime(TYPING_SEND_INTERVAL_MS);
    result.current.onTextChange('Hel');
    expect(send).toHaveBeenCalledTimes(2);

    result.current.onTextChange('   ');
    expect(send).toHaveBeenLastCalledWith(false);
    result.current.stop();
    expect(send).toHaveBeenCalledTimes(3);

    result.current.onTextChange('Again');
    expect(send).toHaveBeenLastCalledWith(true);
    unmount();
    expect(send).toHaveBeenLastCalledWith(false);
  });

  it('stays quiet when the user never typed', () => {
    const send = vi.fn();
    const { unmount } = renderHook(() => useTypingSignal(send));
    unmount();
    expect(send).not.toHaveBeenCalled();
  });

  it('uses the latest sender', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ send }) => useTypingSignal(send), {
      initialProps: { send: first },
    });
    rerender({ send: second });
    result.current.onTextChange('x');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(true);
  });
});
