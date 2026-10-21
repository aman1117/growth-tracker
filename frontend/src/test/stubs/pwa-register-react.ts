/**
 * Stand-in for vite-plugin-pwa's `virtual:pwa-register/react`, which only exists inside a
 * Vite build with the PWA plugin. Tests that care about service-worker updates mock this
 * module with `vi.mock('virtual:pwa-register/react', ...)`.
 */
import { useState } from 'react';
import type { RegisterSWOptions } from 'virtual:pwa-register/react';

export function useRegisterSW(options?: RegisterSWOptions) {
  void options;
  const needRefresh = useState(false);
  const offlineReady = useState(false);
  return { needRefresh, offlineReady, updateServiceWorker: async () => {} };
}
