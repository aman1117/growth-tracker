/**
 * usePullToRefresh Hook
 *
 * Implements a Twitter/X-style pull-to-refresh gesture for window scroll.
 * Uses Pointer Events with Touch Events fallback.
 *
 * Features:
 * - 5-state machine: idle → pulling → armed → refreshing → settling
 * - Resistance curve for natural feel (pullDistance * 0.5)
 * - Haptic feedback when crossing threshold
 * - Horizontal swipe detection to cancel
 * - Minimum spinner display time to avoid flicker
 * - prefers-reduced-motion support
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================================
// Types
// ============================================================================

export type PullToRefreshState = 'idle' | 'pulling' | 'armed' | 'refreshing' | 'settling';

export interface UsePullToRefreshOptions {
  /** Callback to execute on refresh. Must return a Promise. */
  onRefresh: () => Promise<void>;
  /** Distance threshold to trigger refresh (default: 72px) */
  threshold?: number;
  /** Maximum pull distance before clamping (default: 140px) */
  maxPull?: number;
  /** Scroll top tolerance to start tracking (default: 8px) */
  scrollTopTolerance?: number;
  /** Resistance factor (lower = more resistance, default: 0.5) */
  resistanceFactor?: number;
  /** Minimum time to show spinner (default: 300ms) */
  minSpinnerTime?: number;
  /** Disable the hook (e.g., during drag-and-drop) */
  disabled?: boolean;
}

export interface UsePullToRefreshReturn {
  /** Current state of the pull-to-refresh */
  state: PullToRefreshState;
  /** Whether user is actively pulling */
  isPulling: boolean;
  /** Whether pull distance has crossed threshold */
  isArmed: boolean;
  /** Whether refresh is in progress */
  isRefreshing: boolean;
  /** Visual pull offset (with resistance applied) */
  pullOffset: number;
  /** Whether currently settling back to 0 */
  isSettling: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_THRESHOLD = 72;
const DEFAULT_MAX_PULL = 140;
const DEFAULT_SCROLL_TOLERANCE = 8;
const DEFAULT_RESISTANCE = 0.5;
const DEFAULT_MIN_SPINNER_TIME = 300;
const SETTLE_DURATION = 200; // ms

// ============================================================================
// Utilities
// ============================================================================

/** Clamp a value between min and max */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** Check if user prefers reduced motion */
const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Trigger haptic feedback if available */
const triggerHaptic = (): void => {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(10);
    } catch {
      // Haptic not supported or blocked
    }
  }
};

/** Delay helper */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Hook
// ============================================================================

export const usePullToRefresh = (
  options: UsePullToRefreshOptions
): UsePullToRefreshReturn => {
  const {
    onRefresh,
    threshold = DEFAULT_THRESHOLD,
    maxPull = DEFAULT_MAX_PULL,
    scrollTopTolerance = DEFAULT_SCROLL_TOLERANCE,
    resistanceFactor = DEFAULT_RESISTANCE,
    minSpinnerTime = DEFAULT_MIN_SPINNER_TIME,
    disabled = false,
  } = options;

  // ============================================================================
  // State
  // ============================================================================

  const [state, setState] = useState<PullToRefreshState>('idle');
  const [pullOffset, setPullOffset] = useState(0);

  // Refs for tracking gesture
  const startYRef = useRef<number>(0);
  const startXRef = useRef<number>(0);
  const trackingRef = useRef<boolean>(false);
  const cancelledRef = useRef<boolean>(false);
  const hadHapticRef = useRef<boolean>(false);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  // ============================================================================
  // Derived State
  // ============================================================================

  const isPulling = state === 'pulling' || state === 'armed';
  const isArmed = state === 'armed';
  const isRefreshing = state === 'refreshing';
  const isSettling = state === 'settling';

  // ============================================================================
  // Check if at top of page
  // ============================================================================

  const isAtTop = useCallback((): boolean => {
    const scrollY = window.scrollY ?? window.pageYOffset ?? 0;
    return scrollY <= scrollTopTolerance;
  }, [scrollTopTolerance]);

  // Track settle timeout for cleanup
  const settleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ============================================================================
  // Settle animation (return to 0)
  // ============================================================================

  const settle = useCallback(() => {
    setState('settling');
    setPullOffset(0);

    // Clear any existing timeout
    if (settleTimeoutRef.current) {
      clearTimeout(settleTimeoutRef.current);
    }

    const duration = prefersReducedMotion() ? 0 : SETTLE_DURATION;
    settleTimeoutRef.current = setTimeout(() => {
      setState('idle');
      settleTimeoutRef.current = null;
    }, duration);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (settleTimeoutRef.current) {
        clearTimeout(settleTimeoutRef.current);
      }
    };
  }, []);

  // ============================================================================
  // Execute refresh
  // ============================================================================

  const executeRefresh = useCallback(async () => {
    if (refreshPromiseRef.current) {
      // Already refreshing
      return;
    }

    setState('refreshing');

    const startTime = Date.now();

    try {
      refreshPromiseRef.current = onRefresh();
      await refreshPromiseRef.current;
    } catch (error) {
      console.error('[PullToRefresh] Refresh failed:', error);
      // Error handling (toast) is expected to be done in onRefresh callback
    } finally {
      // Ensure minimum spinner display time
      const elapsed = Date.now() - startTime;
      if (elapsed < minSpinnerTime) {
        await delay(minSpinnerTime - elapsed);
      }

      refreshPromiseRef.current = null;
      settle();
    }
  }, [onRefresh, minSpinnerTime, settle]);

  // ============================================================================
  // Pointer/Touch Event Handlers
  // ============================================================================

  const handleStart = useCallback(
    (clientY: number, clientX: number) => {
      if (disabled || state === 'refreshing' || state === 'settling') {
        return;
      }

      if (!isAtTop()) {
        return;
      }

      // Start tracking
      startYRef.current = clientY;
      startXRef.current = clientX;
      trackingRef.current = true;
      cancelledRef.current = false;
      hadHapticRef.current = false;
    },
    [disabled, state, isAtTop]
  );

  const handleMove = useCallback(
    (clientY: number, clientX: number, event: Event) => {
      if (!trackingRef.current || cancelledRef.current) {
        return;
      }

      if (disabled || state === 'refreshing' || state === 'settling') {
        trackingRef.current = false;
        return;
      }

      const deltaY = clientY - startYRef.current;
      const deltaX = clientX - startXRef.current;

      // Cancel if scrolling up or horizontal swipe detected
      if (deltaY < 0) {
        trackingRef.current = false;
        cancelledRef.current = true;
        if (state !== 'idle') {
          settle();
        }
        return;
      }

      // Cancel if horizontal movement exceeds vertical (swipe gesture)
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
        trackingRef.current = false;
        cancelledRef.current = true;
        if (state !== 'idle') {
          settle();
        }
        return;
      }

      // Check if still at top (user might have scrolled)
      if (!isAtTop() && deltaY < threshold) {
        trackingRef.current = false;
        cancelledRef.current = true;
        if (state !== 'idle') {
          settle();
        }
        return;
      }

      // Calculate pull distance with resistance
      const rawPull = clamp(deltaY, 0, maxPull);
      const visualPull = rawPull * resistanceFactor;

      // Prevent default to stop browser overscroll/bounce
      if (rawPull > 0) {
        event.preventDefault();
      }

      setPullOffset(visualPull);

      // Determine state based on visual distance
      const wasArmed = state === 'armed';
      const nowArmed = visualPull >= threshold * resistanceFactor;

      if (nowArmed && !wasArmed) {
        setState('armed');
        if (!hadHapticRef.current) {
          triggerHaptic();
          hadHapticRef.current = true;
        }
      } else if (!nowArmed && state !== 'pulling' && rawPull > 0) {
        setState('pulling');
      } else if (nowArmed && wasArmed) {
        // Still armed, no state change needed
      }
    },
    [disabled, state, isAtTop, maxPull, resistanceFactor, threshold, settle]
  );

  const handleEnd = useCallback(() => {
    if (!trackingRef.current) {
      return;
    }

    trackingRef.current = false;

    if (cancelledRef.current) {
      return;
    }

    if (state === 'armed') {
      // Lock pullOffset at threshold during refresh
      setPullOffset(threshold * resistanceFactor);
      executeRefresh();
    } else if (state === 'pulling') {
      // Snap back without refresh
      settle();
    }
    // If idle, do nothing
  }, [state, threshold, resistanceFactor, executeRefresh, settle]);

  // ============================================================================
  // Event Listeners
  // ============================================================================

  useEffect(() => {
    if (disabled) {
      return;
    }

    // On mobile, always use touch events for better control over native overscroll
    // Pointer events on mobile can be intercepted by browser's native pull-to-refresh
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const useTouch = isTouchDevice;

    // Pointer event handlers (desktop)
    const onPointerDown = (e: PointerEvent) => {
      // Only track primary pointer (finger or left mouse button)
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!e.isPrimary) return;
      // Skip touch pointers - we handle those with touch events
      if (e.pointerType === 'touch') return;
      handleStart(e.clientY, e.clientX);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      if (e.pointerType === 'touch') return;
      handleMove(e.clientY, e.clientX, e);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      if (e.pointerType === 'touch') return;
      handleEnd();
    };

    const onPointerCancel = () => {
      trackingRef.current = false;
      cancelledRef.current = true;
      if (state !== 'idle' && state !== 'refreshing') {
        settle();
      }
    };

    // Touch event handlers (mobile - more reliable than pointer events)
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      handleStart(touch.clientY, touch.clientX);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      handleMove(touch.clientY, touch.clientX, e);
    };

    const onTouchEnd = () => {
      handleEnd();
    };

    const onTouchCancel = () => {
      trackingRef.current = false;
      cancelledRef.current = true;
      if (state !== 'idle' && state !== 'refreshing') {
        settle();
      }
    };

    // Add event listeners - passive: false is crucial for preventDefault to work
    const options: AddEventListenerOptions = { passive: false };

    // Always add touch events on touch devices
    if (useTouch) {
      document.addEventListener('touchstart', onTouchStart, options);
      document.addEventListener('touchmove', onTouchMove, options);
      document.addEventListener('touchend', onTouchEnd, options);
      document.addEventListener('touchcancel', onTouchCancel, options);
    }
    
    // Also add pointer events for desktop mouse support
    document.addEventListener('pointerdown', onPointerDown, options);
    document.addEventListener('pointermove', onPointerMove, options);
    document.addEventListener('pointerup', onPointerUp, options);
    document.addEventListener('pointercancel', onPointerCancel, options);

    // Cleanup
    return () => {
      if (useTouch) {
        document.removeEventListener('touchstart', onTouchStart);
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
        document.removeEventListener('touchcancel', onTouchCancel);
      }
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [disabled, handleStart, handleMove, handleEnd, state, settle]);

  // ============================================================================
  // Return
  // ============================================================================

  return {
    state,
    isPulling,
    isArmed,
    isRefreshing,
    pullOffset,
    isSettling,
  };
};

export default usePullToRefresh;
