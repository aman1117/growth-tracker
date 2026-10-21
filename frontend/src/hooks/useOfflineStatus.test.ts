import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gl } from '../services/goodlogs';
import { useOfflineStatus } from './useOfflineStatus';

const goOffline = () => window.dispatchEvent(new Event('offline'));
const goOnline = () => window.dispatchEvent(new Event('online'));

describe('useOfflineStatus', () => {
  it('starts from the browser connectivity state', () => {
    expect(renderHook(() => useOfflineStatus()).result.current).toBe(false);

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(renderHook(() => useOfflineStatus()).result.current).toBe(true);
  });

  it('follows offline and online events and tracks them', () => {
    const { result } = renderHook(() => useOfflineStatus());

    act(goOffline);
    expect(result.current).toBe(true);
    expect(gl.track).toHaveBeenCalledWith('app_went_offline');

    act(goOnline);
    expect(result.current).toBe(false);
    expect(gl.track).toHaveBeenCalledWith('app_came_online');
  });

  it('re-checks connectivity every 5 seconds for browsers with unreliable events', () => {
    vi.useFakeTimers();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { result } = renderHook(() => useOfflineStatus());

    onLine.mockReturnValue(false);
    act(() => vi.advanceTimersByTime(4999));
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('stops listening and polling on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useOfflineStatus());

    unmount();
    goOffline();

    expect(gl.track).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
