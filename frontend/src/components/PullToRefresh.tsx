import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useSpring, animated } from '@react-spring/web';
import { GrowthSpinner } from './GrowthSpinner';
import { useRefreshOptional } from './RefreshContext';

interface PullToRefreshProps {
    children: React.ReactNode;
    /** Custom refresh handler (overrides context) */
    onRefresh?: () => Promise<void> | void;
    /** Pull distance threshold to trigger refresh (default: 80) */
    threshold?: number;
    /** Whether pull-to-refresh is enabled (default: true) */
    enabled?: boolean;
    /** ID of the scrollable element to track (default: uses window) */
    scrollableId?: string;
}

// Resistance factor for rubber-band effect (lower = more resistance)
const RESISTANCE = 0.4;
// Maximum pull distance allowed
const MAX_PULL = 120;
// Minimum velocity to trigger refresh on quick swipe
const VELOCITY_THRESHOLD = 0.5;
// Spinner size
const SPINNER_SIZE = 32;
// Height of the indicator area
const INDICATOR_HEIGHT = 56;

type RefreshState = 'idle' | 'pulling' | 'ready' | 'refreshing';

/**
 * PullToRefresh - Global pull-to-refresh wrapper component
 * 
 * Implements a native-feeling pull-to-refresh gesture with:
 * - Rubber-band physics for natural feel
 * - Threshold-based activation (100px default)
 * - Haptic feedback at threshold
 * - Integration with RefreshContext for global refresh
 * - Glassmorphism styling to match app design
 * 
 * Usage:
 * ```tsx
 * <PullToRefresh>
 *   <YourContent />
 * </PullToRefresh>
 * ```
 */
export const PullToRefresh: React.FC<PullToRefreshProps> = ({
    children,
    onRefresh,
    threshold = 80,
    enabled = true,
    scrollableId,
}) => {
    const refreshContext = useRefreshOptional();
    const containerRef = useRef<HTMLDivElement>(null);
    const touchStartY = useRef<number>(0);
    const touchStartTime = useRef<number>(0);
    const lastTouchY = useRef<number>(0);
    const isTracking = useRef<boolean>(false);
    const hasTriggeredHaptic = useRef<boolean>(false);

    const [state, setState] = useState<RefreshState>('idle');
    const [pullDistance, setPullDistance] = useState(0);

    // Spring animation for the indicator position (not content)
    const [{ indicatorY }, springApi] = useSpring(() => ({
        indicatorY: -INDICATOR_HEIGHT,
        config: { tension: 300, friction: 30 },
    }));

    // Spring for the indicator opacity and scale
    const indicatorSpring = useSpring({
        opacity: state === 'idle' ? 0 : 1,
        scale: state === 'idle' ? 0.6 : 1,
        config: { tension: 400, friction: 25 },
    });

    // Calculate if we're at the top of the scroll
    const isAtTop = useCallback((): boolean => {
        if (scrollableId) {
            const element = document.getElementById(scrollableId);
            return element ? element.scrollTop <= 0 : true;
        }
        return window.scrollY <= 0;
    }, [scrollableId]);

    // Haptic feedback
    const triggerHaptic = useCallback(() => {
        if ('vibrate' in navigator) {
            navigator.vibrate(10);
        }
    }, []);

    // Handle refresh trigger
    const handleRefresh = useCallback(async () => {
        setState('refreshing');
        // Keep indicator visible during refresh
        springApi.start({ indicatorY: 8 });
        
        try {
            if (onRefresh) {
                await onRefresh();
            } else if (refreshContext) {
                await refreshContext.triggerRefresh();
            }
            
            triggerHaptic();
            
            // Brief pause before hiding
            await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
            console.error('Refresh failed:', error);
        } finally {
            setState('idle');
            setPullDistance(0);
            springApi.start({ indicatorY: -INDICATOR_HEIGHT });
        }
    }, [onRefresh, refreshContext, springApi, triggerHaptic]);

    // Touch event handlers
    const handleTouchStart = useCallback((e: React.TouchEvent | TouchEvent) => {
        if (!enabled || state === 'refreshing') return;
        if (!isAtTop()) return;

        const touch = e.touches[0];
        touchStartY.current = touch.clientY;
        touchStartTime.current = Date.now();
        lastTouchY.current = touch.clientY;
        isTracking.current = true;
        hasTriggeredHaptic.current = false;
    }, [enabled, state, isAtTop]);

    const handleTouchMove = useCallback((e: React.TouchEvent | TouchEvent) => {
        if (!isTracking.current || !enabled) return;
        if (state === 'refreshing') return;

        const touch = e.touches[0];
        const deltaY = touch.clientY - touchStartY.current;
        lastTouchY.current = touch.clientY;

        // Only track downward pulls when at top
        if (deltaY < 0 || !isAtTop()) {
            if (state !== 'idle') {
                setState('idle');
                setPullDistance(0);
                springApi.start({ indicatorY: -INDICATOR_HEIGHT });
            }
            return;
        }

        // Prevent default scroll behavior while pulling
        e.preventDefault();

        // Apply rubber-band resistance
        const resistedDelta = Math.min(deltaY * RESISTANCE, MAX_PULL);
        
        setPullDistance(resistedDelta);
        // Move indicator into view based on pull distance
        const indicatorPos = Math.min(resistedDelta - INDICATOR_HEIGHT, 8);
        springApi.start({ indicatorY: indicatorPos, immediate: true });

        // Update state based on pull distance
        if (resistedDelta >= threshold) {
            if (state !== 'ready') {
                setState('ready');
                // Haptic feedback when crossing threshold
                if (!hasTriggeredHaptic.current) {
                    triggerHaptic();
                    hasTriggeredHaptic.current = true;
                }
            }
        } else {
            if (state !== 'pulling') {
                setState('pulling');
            }
        }
    }, [enabled, state, isAtTop, threshold, springApi, triggerHaptic]);

    const handleTouchEnd = useCallback(() => {
        if (!isTracking.current) return;
        isTracking.current = false;

        if (state === 'refreshing') return;

        // Calculate velocity for quick-swipe detection
        const elapsed = Date.now() - touchStartTime.current;
        const velocity = pullDistance / elapsed;

        if (state === 'ready' || (pullDistance > threshold * 0.7 && velocity > VELOCITY_THRESHOLD)) {
            // Trigger refresh
            handleRefresh();
        } else {
            // Snap back
            setState('idle');
            setPullDistance(0);
            springApi.start({ indicatorY: -INDICATOR_HEIGHT });
        }
    }, [state, pullDistance, threshold, springApi, handleRefresh]);

    // Use ref to track pull distance for event handler (avoids stale closure)
    const pullDistanceRef = useRef(0);
    useEffect(() => {
        pullDistanceRef.current = pullDistance;
    }, [pullDistance]);

    // Add passive: false to prevent scroll during pull
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const touchMoveHandler = (e: TouchEvent) => {
            if (isTracking.current && pullDistanceRef.current > 0) {
                e.preventDefault();
            }
            handleTouchMove(e);
        };

        const touchCancelHandler = () => {
            // Handle edge case: touch cancelled (e.g., incoming call)
            if (isTracking.current) {
                isTracking.current = false;
                setState('idle');
                setPullDistance(0);
                springApi.start({ indicatorY: -INDICATOR_HEIGHT });
            }
        };

        container.addEventListener('touchstart', handleTouchStart as (e: TouchEvent) => void, { passive: true });
        container.addEventListener('touchmove', touchMoveHandler, { passive: false });
        container.addEventListener('touchend', handleTouchEnd);
        container.addEventListener('touchcancel', touchCancelHandler);

        return () => {
            container.removeEventListener('touchstart', handleTouchStart as (e: TouchEvent) => void);
            container.removeEventListener('touchmove', touchMoveHandler);
            container.removeEventListener('touchend', handleTouchEnd);
            container.removeEventListener('touchcancel', touchCancelHandler);
        };
    }, [handleTouchStart, handleTouchMove, handleTouchEnd, springApi]);

    // Calculate progress for spinner (0-1)
    const progress = Math.min(pullDistance / threshold, 1);

    return (
        <div
            ref={containerRef}
            style={{
                position: 'relative',
                minHeight: '100%',
                touchAction: state === 'idle' ? 'auto' : 'none',
                overscrollBehavior: 'contain',
            }}
        >
            {/* Pull-to-refresh indicator - positioned below header */}
            <animated.div
                style={{
                    position: 'fixed',
                    top: 'calc(env(safe-area-inset-top, 0px) + 52px)', // Below header
                    left: 0,
                    right: 0,
                    height: INDICATOR_HEIGHT,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    pointerEvents: 'none',
                    zIndex: 40, // Below header (z-50)
                    transform: indicatorY.to(y => `translateY(${y}px)`),
                    opacity: indicatorSpring.opacity,
                }}
            >
                {/* Minimal container */}
                <animated.div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transform: indicatorSpring.scale.to(s => `scale(${s})`),
                    }}
                >
                    <GrowthSpinner
                        progress={progress}
                        isRefreshing={state === 'refreshing'}
                        size={SPINNER_SIZE}
                    />
                </animated.div>
            </animated.div>

            {/* Content - no translation, stays in place */}
            {children}
        </div>
    );
};

export default PullToRefresh;
