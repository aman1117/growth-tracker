/**
 * Silent stand-in for the GoodLogs analytics SDK (a third-party boundary). Every method is a
 * spy, so tests can assert analytics calls, e.g.
 * `expect(gl.track).toHaveBeenCalledWith('login', expect.anything())` after importing `gl`
 * from `src/services/goodlogs`.
 */
import { vi } from 'vitest';

export class GoodLogs {
  readonly options: unknown;
  constructor(options: unknown) {
    this.options = options;
  }
  log = vi.fn();
  debug = vi.fn();
  info = vi.fn();
  warn = vi.fn();
  error = vi.fn();
  fatal = vi.fn();
  track = vi.fn();
  identify = vi.fn();
  reset = vi.fn();
  newSession = vi.fn();
  setSessionId = vi.fn();
  getDistinctId = vi.fn(() => 'test-distinct-id');
  getSessionId = vi.fn(() => 'test-session-id');
  flush = vi.fn(async () => {});
  shutdown = vi.fn(async () => {});
}
