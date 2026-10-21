import { describe, expect, it } from 'vitest';

import { BREAKPOINTS as TOKEN_BREAKPOINTS } from './tokens';
import { ANIMATION, BREAKPOINTS, DEBOUNCE } from './ui';

describe('UI constants', () => {
  it('orders the breakpoints from mobile to desktop', () => {
    expect(BREAKPOINTS.MOBILE).toBeLessThan(BREAKPOINTS.TABLET);
    expect(BREAKPOINTS.TABLET).toBeLessThan(BREAKPOINTS.DESKTOP);
  });

  it('agrees with the design-token breakpoints where they overlap', () => {
    expect(BREAKPOINTS.TABLET).toBe(TOKEN_BREAKPOINTS.md);
    expect(BREAKPOINTS.DESKTOP).toBe(TOKEN_BREAKPOINTS.lg);
  });

  it('uses positive whole-millisecond durations', () => {
    [...Object.values(ANIMATION), ...Object.values(DEBOUNCE)].forEach((ms) => {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
    });
  });
});
