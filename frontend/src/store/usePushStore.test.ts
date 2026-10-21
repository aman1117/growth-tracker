import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../constants/storage';
import { gl } from '../services/goodlogs';
import { pushService } from '../services/pushService';
import { deferred, makePushPreferences } from '../test/fixtures/shell';
import type { PreferencesResponse, PushPermissionState, SubscribeResponse } from '../types/push';
import {
  usePushError,
  usePushLoading,
  usePushPermission,
  usePushPreferences,
  usePushStore,
  usePushSubscribed,
  usePushSupported,
} from './usePushStore';

vi.mock('../services/pushService', () => ({
  pushService: {
    isSupported: vi.fn(),
    getPermissionState: vi.fn(),
    getExistingSubscription: vi.fn(),
    confirmSubscription: vi.fn(),
    requestPermission: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
  },
}));

const service = vi.mocked(pushService);
const store = () => usePushStore.getState();

/** `fetchPreferences` also accepts a `force` flag that its public type does not declare. */
const forceFetchPreferences = () =>
  (store().fetchPreferences as (force?: boolean) => Promise<void>)(true);

const enableSupport = (permission: PushPermissionState = 'default') =>
  usePushStore.setState({ isSupported: true, permission });

describe('usePushStore', () => {
  beforeEach(() => {
    Object.values(service).forEach((fn) => fn.mockReset());
    // Also clears the module-level "preferences already fetched" flag
    store().reset();
  });

  describe('checkSupport', () => {
    it('reports browsers without Web Push', () => {
      service.isSupported.mockReturnValue(false);
      service.getPermissionState.mockReturnValue('unsupported');

      expect(store().checkSupport()).toBe(false);

      expect(store()).toMatchObject({ isSupported: false, permission: 'unsupported' });
      expect(service.getExistingSubscription).not.toHaveBeenCalled();
    });

    it('restores the subscription state once permission was granted', async () => {
      service.isSupported.mockReturnValue(true);
      service.getPermissionState.mockReturnValue('granted');
      service.getExistingSubscription.mockResolvedValue({} as PushSubscription);

      expect(store().checkSupport()).toBe(true);

      expect(store()).toMatchObject({ isSupported: true, permission: 'granted' });
      await vi.waitFor(() => expect(store().isSubscribed).toBe(true));
    });

    it('notices when the browser subscription is gone', async () => {
      usePushStore.setState({ isSubscribed: true });
      service.isSupported.mockReturnValue(true);
      service.getPermissionState.mockReturnValue('granted');
      service.getExistingSubscription.mockResolvedValue(null);

      store().checkSupport();

      await vi.waitFor(() => expect(store().isSubscribed).toBe(false));
    });

    it('does not look for a subscription before permission is granted', () => {
      service.isSupported.mockReturnValue(true);
      service.getPermissionState.mockReturnValue('default');

      store().checkSupport();

      expect(store().permission).toBe('default');
      expect(service.getExistingSubscription).not.toHaveBeenCalled();
    });

    it('logs instead of failing when the subscription cannot be read', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failure = new Error('No service worker');
      service.isSupported.mockReturnValue(true);
      service.getPermissionState.mockReturnValue('granted');
      service.getExistingSubscription.mockRejectedValue(failure);

      store().checkSupport();

      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[Push] Could not check this device’s subscription',
          failure
        )
      );
      expect(store().isSubscribed).toBe(false);
    });

    describe('while signed in', () => {
      const subscription = { endpoint: 'https://push.example.com/1' } as PushSubscription;
      // Lets the subscription check that checkSupport started run to the end
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      beforeEach(() => {
        localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, 'jwt-alice');
        service.isSupported.mockReturnValue(true);
        service.getPermissionState.mockReturnValue('granted');
        service.getExistingSubscription.mockResolvedValue(subscription);
      });

      it('confirms the subscription with the server once per session', async () => {
        service.confirmSubscription.mockResolvedValue('registered');

        store().checkSupport();
        await vi.waitFor(() => expect(store().isSubscribed).toBe(true));
        store().checkSupport();
        await settle();

        expect(service.confirmSubscription).toHaveBeenCalledExactlyOnceWith(subscription);
        expect(store().isSubscribed).toBe(true);
      });

      it('shows push as off when the subscription belonged to another account', async () => {
        usePushStore.setState({ isSubscribed: true });
        service.confirmSubscription.mockResolvedValue('removed');

        store().checkSupport();

        await vi.waitFor(() => expect(store().isSubscribed).toBe(false));
      });

      it('keeps the device state when the server cannot be asked, and asks again later', async () => {
        service.confirmSubscription.mockResolvedValue('unchecked');

        store().checkSupport();
        await vi.waitFor(() => expect(store().isSubscribed).toBe(true));
        store().checkSupport();

        await vi.waitFor(() => expect(service.confirmSubscription).toHaveBeenCalledTimes(2));
      });

      it('confirms again in the next session', async () => {
        service.confirmSubscription.mockResolvedValue('registered');
        store().checkSupport();
        await vi.waitFor(() => expect(store().isSubscribed).toBe(true));

        // Every sign-in and sign-out resets the store
        store().reset();
        store().checkSupport();

        await vi.waitFor(() => expect(service.confirmSubscription).toHaveBeenCalledTimes(2));
      });

      it('never asks the server once signed out', async () => {
        localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);

        store().checkSupport();
        await vi.waitFor(() => expect(store().isSubscribed).toBe(true));

        expect(service.confirmSubscription).not.toHaveBeenCalled();
      });
    });
  });

  describe('requestPermission', () => {
    it('refuses on unsupported browsers', async () => {
      await expect(store().requestPermission()).resolves.toBe('denied');

      expect(store().error).toBe('Push notifications not supported');
      expect(service.requestPermission).not.toHaveBeenCalled();
    });

    it('stores the permission the user chose', async () => {
      enableSupport();
      usePushStore.setState({ error: 'old error' });
      service.requestPermission.mockResolvedValue('granted');

      await expect(store().requestPermission()).resolves.toBe('granted');

      expect(store()).toMatchObject({ permission: 'granted', error: null });
    });

    it('reports failures as a denied permission', async () => {
      enableSupport();
      service.requestPermission.mockRejectedValueOnce(new Error('Blocked by the browser'));
      await expect(store().requestPermission()).resolves.toBe('denied');
      expect(store().error).toBe('Blocked by the browser');

      service.requestPermission.mockRejectedValueOnce('nope');
      await store().requestPermission();
      expect(store().error).toBe('Permission request failed');
    });
  });

  describe('subscribe', () => {
    it('refuses on unsupported browsers', async () => {
      await expect(store().subscribe()).resolves.toBe(false);

      expect(store().error).toBe('Push notifications not supported');
      expect(service.subscribe).not.toHaveBeenCalled();
    });

    it('refuses when notifications are blocked', async () => {
      enableSupport('denied');

      await expect(store().subscribe()).resolves.toBe(false);

      expect(store().error).toBe('Notification permission was denied');
      expect(service.subscribe).not.toHaveBeenCalled();
    });

    it('subscribes, then loads the notification preferences', async () => {
      enableSupport();
      const request = deferred<SubscribeResponse>();
      service.subscribe.mockReturnValue(request.promise);
      const preferences = makePushPreferences();
      service.getPreferences.mockResolvedValue({ success: true, preferences });

      const subscribing = store().subscribe();
      expect(store()).toMatchObject({ isLoading: true, error: null });

      request.resolve({ success: true, subscription_id: 1 });
      await expect(subscribing).resolves.toBe(true);

      expect(store()).toMatchObject({
        isSubscribed: true,
        isLoading: false,
        permission: 'granted',
      });
      expect(gl.track).toHaveBeenCalledWith('push_subscribed');
      await vi.waitFor(() => expect(store().preferences).toEqual(preferences));
    });

    it('persists only the subscription flag', async () => {
      enableSupport('granted');
      service.subscribe.mockResolvedValue({ success: true });
      service.getPreferences.mockResolvedValue({
        success: true,
        preferences: makePushPreferences(),
      });

      await store().subscribe();

      expect(JSON.parse(localStorage.getItem('push-storage') ?? 'null')).toEqual({
        state: { isSubscribed: true },
        version: 0,
      });
    });

    it('surfaces the server message when the subscription is rejected', async () => {
      enableSupport();
      service.subscribe.mockResolvedValueOnce({ success: false, message: 'Too many devices' });
      await expect(store().subscribe()).resolves.toBe(false);
      expect(store()).toMatchObject({ error: 'Too many devices', isLoading: false });

      service.subscribe.mockResolvedValueOnce({ success: false });
      await store().subscribe();
      expect(store().error).toBe('Subscription failed');

      expect(store().isSubscribed).toBe(false);
    });

    it('reports unexpected failures', async () => {
      enableSupport();
      service.subscribe.mockRejectedValue(undefined);

      await expect(store().subscribe()).resolves.toBe(false);

      expect(store()).toMatchObject({ error: 'Failed to subscribe', isLoading: false });
    });
  });

  describe('unsubscribe', () => {
    it('unsubscribes and forgets the preferences', async () => {
      usePushStore.setState({ isSubscribed: true, preferences: makePushPreferences() });
      service.unsubscribe.mockResolvedValue({ success: true });

      const unsubscribing = store().unsubscribe();
      expect(store().isLoading).toBe(true);
      await expect(unsubscribing).resolves.toBe(true);

      expect(store()).toMatchObject({ isSubscribed: false, isLoading: false, preferences: null });
      expect(gl.track).toHaveBeenCalledWith('push_unsubscribed');
    });

    it('lets preferences be fetched again after resubscribing', async () => {
      service.getPreferences.mockResolvedValue({
        success: true,
        preferences: makePushPreferences(),
      });
      await store().fetchPreferences();
      service.unsubscribe.mockResolvedValue({ success: true });

      await store().unsubscribe();
      await store().fetchPreferences();

      expect(service.getPreferences).toHaveBeenCalledTimes(2);
    });

    it('reports failures and keeps the subscription', async () => {
      usePushStore.setState({ isSubscribed: true });
      service.unsubscribe.mockRejectedValueOnce(new Error('Service worker missing'));
      await expect(store().unsubscribe()).resolves.toBe(false);
      expect(store()).toMatchObject({
        isSubscribed: true,
        isLoading: false,
        error: 'Service worker missing',
      });

      service.unsubscribe.mockRejectedValueOnce('nope');
      await store().unsubscribe();
      expect(store().error).toBe('Failed to unsubscribe');
    });
  });

  describe('fetchPreferences', () => {
    it('loads the saved preferences once per session', async () => {
      const preferences = makePushPreferences({ quiet_hours_enabled: true });
      service.getPreferences.mockResolvedValue({ success: true, preferences });

      await store().fetchPreferences();
      await store().fetchPreferences();

      expect(store().preferences).toEqual(preferences);
      expect(service.getPreferences).toHaveBeenCalledTimes(1);
    });

    it('can be forced to reload', async () => {
      service.getPreferences.mockResolvedValue({
        success: true,
        preferences: makePushPreferences(),
      });

      await store().fetchPreferences();
      await forceFetchPreferences();

      expect(service.getPreferences).toHaveBeenCalledTimes(2);
    });

    it('falls back to defaults when nothing is saved yet', async () => {
      service.getPreferences.mockResolvedValue({ success: true });

      await store().fetchPreferences();

      expect(store().preferences).toEqual({
        push_enabled: true,
        preferences: {
          like_received: true,
          badge_unlocked: true,
          streak_milestone: true,
          streak_at_risk: true,
          system_announcement: true,
        },
        quiet_hours_enabled: false,
        quiet_start: null,
        quiet_end: null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    });

    it('falls back to defaults when loading fails', async () => {
      service.getPreferences.mockRejectedValue(new Error('Not found'));

      await store().fetchPreferences();

      expect(store().preferences).toMatchObject({ push_enabled: true, quiet_hours_enabled: false });
    });
  });

  describe('updatePreferences', () => {
    it('applies changes immediately and then keeps the saved version', async () => {
      const current = makePushPreferences();
      usePushStore.setState({ preferences: current });
      const request = deferred<PreferencesResponse>();
      service.updatePreferences.mockReturnValue(request.promise);
      const update = { quiet_hours_enabled: true, preferences: { like_received: false } };

      const saving = store().updatePreferences(update);
      expect(service.updatePreferences).toHaveBeenCalledWith(update);
      expect(store().preferences).toEqual({
        ...current,
        quiet_hours_enabled: true,
        preferences: { like_received: false, badge_unlocked: true },
      });

      const saved = makePushPreferences({ quiet_hours_enabled: true, quiet_start: '22:00' });
      request.resolve({ success: true, preferences: saved });
      await expect(saving).resolves.toBe(true);

      expect(store().preferences).toEqual(saved);
      expect(gl.track).toHaveBeenCalledWith('push_preferences_updated');
    });

    it('updates top-level settings without touching per-type toggles', async () => {
      const current = makePushPreferences();
      usePushStore.setState({ preferences: current });
      service.updatePreferences.mockReturnValue(new Promise(() => {}));

      void store().updatePreferences({ push_enabled: false });

      expect(store().preferences).toEqual({ ...current, push_enabled: false });
    });

    it('reverts when the server refuses the change', async () => {
      const current = makePushPreferences();
      usePushStore.setState({ preferences: current });
      service.updatePreferences.mockResolvedValue({ success: false, message: 'Invalid time' });

      await expect(store().updatePreferences({ quiet_start: '25:00' })).resolves.toBe(false);

      expect(store().preferences).toBe(current);
      expect(gl.track).not.toHaveBeenCalled();
    });

    it('reverts when saving fails', async () => {
      const current = makePushPreferences();
      usePushStore.setState({ preferences: current });
      service.updatePreferences.mockRejectedValue(new Error('Network down'));

      await expect(store().updatePreferences({ push_enabled: false })).resolves.toBe(false);

      expect(store().preferences).toBe(current);
    });

    it('works before preferences were loaded', async () => {
      service.updatePreferences.mockResolvedValueOnce({ success: false });
      await expect(store().updatePreferences({ push_enabled: false })).resolves.toBe(false);
      expect(store().preferences).toBeNull();

      service.updatePreferences.mockRejectedValueOnce(new Error('Network down'));
      await expect(store().updatePreferences({ push_enabled: false })).resolves.toBe(false);
      expect(store().preferences).toBeNull();

      const saved = makePushPreferences({ push_enabled: false });
      service.updatePreferences.mockResolvedValueOnce({ success: true, preferences: saved });
      await expect(store().updatePreferences({ push_enabled: false })).resolves.toBe(true);
      expect(store().preferences).toEqual(saved);
    });
  });

  describe('persistence', () => {
    it('restores the subscription flag from storage', async () => {
      localStorage.setItem(
        'push-storage',
        JSON.stringify({ state: { isSubscribed: true }, version: 0 })
      );

      await usePushStore.persist.rehydrate();

      expect(store()).toMatchObject({ isSubscribed: true, isSupported: false, preferences: null });
    });
  });

  it('reset returns to the initial state', () => {
    usePushStore.setState({
      isSupported: true,
      permission: 'granted',
      isSubscribed: true,
      isLoading: true,
      error: 'x',
      preferences: makePushPreferences(),
    });

    store().reset();

    expect(store()).toMatchObject({
      isSupported: false,
      permission: 'default',
      isSubscribed: false,
      isLoading: false,
      error: null,
      preferences: null,
    });
  });

  it('selector hooks follow the store', () => {
    const hooks = {
      supported: renderHook(() => usePushSupported()),
      permission: renderHook(() => usePushPermission()),
      subscribed: renderHook(() => usePushSubscribed()),
      loading: renderHook(() => usePushLoading()),
      error: renderHook(() => usePushError()),
      preferences: renderHook(() => usePushPreferences()),
    };
    const preferences = makePushPreferences();

    act(() =>
      usePushStore.setState({
        isSupported: true,
        permission: 'granted',
        isSubscribed: true,
        isLoading: true,
        error: 'Oops',
        preferences,
      })
    );

    expect(hooks.supported.result.current).toBe(true);
    expect(hooks.permission.result.current).toBe('granted');
    expect(hooks.subscribed.result.current).toBe(true);
    expect(hooks.loading.result.current).toBe(true);
    expect(hooks.error.result.current).toBe('Oops');
    expect(hooks.preferences.result.current).toBe(preferences);
  });
});
