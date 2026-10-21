import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { usePushStore } from '../store/usePushStore';
import type { PushState } from '../types/push';
import { usePushNotifications } from './usePushNotifications';

/** Puts the push store in a given state with spy actions (the store itself is tested separately). */
function setUpPushStore(state: Partial<PushState> = {}) {
  const actions = {
    checkSupport: vi.fn(() => true),
    fetchPreferences: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(true),
    unsubscribe: vi.fn().mockResolvedValue(true),
    updatePreferences: vi.fn().mockResolvedValue(true),
  };
  usePushStore.setState({
    isSupported: true,
    permission: 'default',
    isSubscribed: false,
    ...state,
    ...actions,
  });
  return actions;
}

function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('usePushNotifications', () => {
  it('checks browser support on mount without loading preferences for non-subscribers', () => {
    const actions = setUpPushStore();

    renderHook(() => usePushNotifications());

    expect(actions.checkSupport).toHaveBeenCalledTimes(1);
    expect(actions.fetchPreferences).not.toHaveBeenCalled();
  });

  it('loads preferences on mount for subscribers', () => {
    const actions = setUpPushStore({ isSubscribed: true, permission: 'granted' });

    renderHook(() => usePushNotifications());

    expect(actions.fetchPreferences).toHaveBeenCalledTimes(1);
  });

  it('re-checks support when the tab becomes visible again', () => {
    const actions = setUpPushStore();
    const { unmount } = renderHook(() => usePushNotifications());

    setVisibility('hidden');
    expect(actions.checkSupport).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    expect(actions.checkSupport).toHaveBeenCalledTimes(2);

    unmount();
    setVisibility('visible');
    expect(actions.checkSupport).toHaveBeenCalledTimes(2);
  });

  it('delegates subscribe, unsubscribe and preference updates to the store', async () => {
    const actions = setUpPushStore();
    actions.unsubscribe.mockResolvedValue(false);
    const { result } = renderHook(() => usePushNotifications());

    await expect(result.current.subscribe()).resolves.toBe(true);
    await expect(result.current.unsubscribe()).resolves.toBe(false);
    await expect(result.current.updatePreferences({ push_enabled: false })).resolves.toBe(true);

    expect(actions.subscribe).toHaveBeenCalledTimes(1);
    expect(actions.unsubscribe).toHaveBeenCalledTimes(1);
    expect(actions.updatePreferences).toHaveBeenCalledWith({ push_enabled: false });
  });

  it.each([
    [false, 'subscribe'],
    [true, 'unsubscribe'],
  ] as const)('toggles (subscribed: %s) by calling %s', async (isSubscribed, action) => {
    const actions = setUpPushStore({ isSubscribed });
    const { result } = renderHook(() => usePushNotifications());

    await expect(result.current.toggleSubscription()).resolves.toBe(true);

    expect(actions[action]).toHaveBeenCalledTimes(1);
    expect(actions[action === 'subscribe' ? 'unsubscribe' : 'subscribe']).not.toHaveBeenCalled();
  });

  it('clears the error', () => {
    setUpPushStore({ error: 'Notification permission was denied' });
    const { result } = renderHook(() => usePushNotifications());
    expect(result.current.error).toBe('Notification permission was denied');

    act(() => result.current.clearError());

    expect(result.current.error).toBeNull();
    expect(usePushStore.getState().error).toBeNull();
  });

  it('exposes the store state', () => {
    const preferences = {
      push_enabled: true,
      preferences: { like_received: true },
      quiet_hours_enabled: false,
      quiet_start: null,
      quiet_end: null,
      timezone: 'Asia/Kolkata',
    };
    setUpPushStore({ isSubscribed: true, permission: 'granted', isLoading: true, preferences });

    const { result } = renderHook(() => usePushNotifications());

    expect(result.current).toMatchObject({
      isSupported: true,
      permission: 'granted',
      isSubscribed: true,
      isLoading: true,
      error: null,
      preferences,
    });
  });

  it.each<[Partial<PushState>, boolean, boolean]>([
    [{ isSupported: true, permission: 'default', isSubscribed: false }, true, true],
    [{ isSupported: true, permission: 'default', isSubscribed: true }, true, false],
    [{ isSupported: true, permission: 'granted', isSubscribed: false }, true, false],
    [{ isSupported: true, permission: 'denied', isSubscribed: false }, false, false],
    [{ isSupported: false, permission: 'unsupported', isSubscribed: false }, false, false],
  ])('for %o: canSubscribe=%s, showPermissionPrompt=%s', (state, canSubscribe, showPrompt) => {
    setUpPushStore(state);

    const { result } = renderHook(() => usePushNotifications());

    expect(result.current.canSubscribe).toBe(canSubscribe);
    expect(result.current.showPermissionPrompt).toBe(showPrompt);
  });
});
