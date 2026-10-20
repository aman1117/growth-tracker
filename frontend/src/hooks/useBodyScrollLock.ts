/**
 * useBodyScrollLock Hook
 *
 * Locks page scrolling while an overlay is open. Locks are reference-counted and
 * shared by every overlay, so nested overlays can close in any order — including
 * unmounting together in one commit, where React runs cleanups parent → child —
 * and the page unlocks only when the last overlay releases its lock.
 *
 * @example
 * useBodyScrollLock(isOpen);
 * useBodyScrollLock(isOpen, { blockTouch: true }); // full-screen gesture surfaces
 */

import { useEffect } from 'react';

type LockedStyle = 'overflow' | 'touchAction';

const LOCKED_VALUES: Record<LockedStyle, string> = {
  overflow: 'hidden',
  touchAction: 'none',
};

const lockCounts: Record<LockedStyle, number> = { overflow: 0, touchAction: 0 };
const originalValues: Partial<Record<LockedStyle, string>> = {};

const acquire = (style: LockedStyle) => {
  if (lockCounts[style] === 0) {
    originalValues[style] = document.body.style[style];
    document.body.style[style] = LOCKED_VALUES[style];
  }
  lockCounts[style] += 1;
};

const release = (style: LockedStyle) => {
  if (lockCounts[style] === 0) return;
  lockCounts[style] -= 1;
  if (lockCounts[style] === 0) {
    document.body.style[style] = originalValues[style] ?? '';
    delete originalValues[style];
  }
};

export interface BodyScrollLockOptions {
  /** Also sets `touch-action: none` on the body (e.g. the story viewer's swipe surface) */
  blockTouch?: boolean;
}

/** Imperative variant for non-React callers. Returns an idempotent release function. */
export function lockBodyScroll({ blockTouch = false }: BodyScrollLockOptions = {}): () => void {
  if (typeof document === 'undefined') return () => {};

  const lockedStyles: LockedStyle[] = blockTouch ? ['overflow', 'touchAction'] : ['overflow'];
  lockedStyles.forEach(acquire);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockedStyles.forEach(release);
  };
}

export function useBodyScrollLock(isLocked: boolean, options: BodyScrollLockOptions = {}): void {
  const blockTouch = options.blockTouch ?? false;

  useEffect(() => {
    if (!isLocked) return;
    return lockBodyScroll({ blockTouch });
  }, [isLocked, blockTouch]);
}

export default useBodyScrollLock;
