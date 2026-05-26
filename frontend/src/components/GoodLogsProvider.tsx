/**
 * GoodLogsProvider
 *
 * Lifecycle wrapper that ensures the GoodLogs SDK shuts down gracefully
 * when the app unmounts (flushes pending events and stops timers).
 */

import type { ReactNode } from 'react';
import { useEffect } from 'react';

import { gl } from '../services/goodlogs';

export const GoodLogsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  useEffect(() => {
    return () => {
      gl.shutdown();
    };
  }, []);

  return <>{children}</>;
};
