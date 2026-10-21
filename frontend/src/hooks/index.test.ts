import { describe, expect, it } from 'vitest';

describe('hooks barrel', () => {
  it('re-exports every shared hook', async () => {
    // Imported inside the test: the store barrel reads matchMedia at load time, and the
    // test setup only stubs it per test.
    const [
      hooks,
      { useBackDismiss },
      { lockBodyScroll, useBodyScrollLock },
      { useDebounce },
      { useEscapeKey },
      { useOfflineStatus },
      { useOverlayAwareNavigate },
      { usePullToRefresh },
      { usePushNotifications },
      { useSmartBack },
      { useWebSocket },
    ] = await Promise.all([
      import('./index'),
      import('./useBackDismiss'),
      import('./useBodyScrollLock'),
      import('./useDebounce'),
      import('./useEscapeKey'),
      import('./useOfflineStatus'),
      import('./useOverlayAwareNavigate'),
      import('./usePullToRefresh'),
      import('./usePushNotifications'),
      import('./useSmartBack'),
      import('./useWebSocket'),
    ]);

    expect({ ...hooks }).toEqual({
      useBackDismiss,
      lockBodyScroll,
      useBodyScrollLock,
      useDebounce,
      useEscapeKey,
      useOfflineStatus,
      useOverlayAwareNavigate,
      usePullToRefresh,
      usePushNotifications,
      useSmartBack,
      useWebSocket,
    });
  });
});
