/**
 * PullToRefreshIndicator Component
 *
 * Twitter-style - arrow while pulling, spinner while refreshing.
 * Clean minimal design without background.
 */

import React, { useEffect, useRef } from 'react';
import { ArrowDown, Loader2 } from 'lucide-react';

import type { PullToRefreshState } from '../../../hooks/usePullToRefresh';

import styles from './PullToRefreshIndicator.module.css';

export interface PullToRefreshIndicatorProps {
  state: PullToRefreshState;
  pullOffset: number;
  threshold: number;
  className?: string;
}

/** Animation duration in ms for settle animation */
const ANIMATION_DURATION = 200;
/** Header height offset for positioning */
const HEADER_OFFSET = 56;

export const PullToRefreshIndicator: React.FC<PullToRefreshIndicatorProps> = ({
  state,
  pullOffset,
  threshold,
  className = '',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAnimatingOutRef = useRef(false);
  const animationRef = useRef<Animation | null>(null);
  
  const isRefreshing = state === 'refreshing';
  const isArmed = state === 'armed';
  const isPulling = state === 'pulling' || state === 'armed';
  const isSettling = state === 'settling';
  const shouldShow = isPulling || isRefreshing || isSettling;

  // Calculate arrow rotation (0 to 180 when threshold reached)
  const progress = Math.min(pullOffset / threshold, 1);
  const arrowRotation = progress * 180;

  // Handle settle animation - slide up when releasing
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (isSettling && !isAnimatingOutRef.current) {
      isAnimatingOutRef.current = true;
      
      // Get current visual position
      const rect = container.getBoundingClientRect();
      const startY = rect.top - HEADER_OFFSET;
      
      // Cancel any existing animation
      if (animationRef.current) {
        animationRef.current.cancel();
      }
      
      // Animate out using Web Animations API
      animationRef.current = container.animate(
        [
          { transform: `translateY(${startY}px)`, opacity: 1 },
          { transform: 'translateY(-40px)', opacity: 0 }
        ],
        {
          duration: ANIMATION_DURATION,
          easing: 'cubic-bezier(0.4, 0, 1, 1)', // ease-in
          fill: 'forwards'
        }
      );

      animationRef.current.onfinish = () => {
        isAnimatingOutRef.current = false;
        animationRef.current = null;
      };
    }
    
    // Cleanup animation on unmount
    return () => {
      if (animationRef.current) {
        animationRef.current.cancel();
        animationRef.current = null;
      }
    };
  }, [isSettling]);

  // Reset animation flag when becoming active again
  useEffect(() => {
    if (shouldShow) {
      isAnimatingOutRef.current = false;
    }
  }, [shouldShow]);

  // Don't render at all if not active
  if (!shouldShow) {
    return null;
  }

  // Calculate position - show at pullOffset position during pull, fixed at 16px during refresh
  const translateY = isPulling ? Math.max(pullOffset - 24, 0) : 16;

  // Don't apply inline styles during settle animation (Web Animations API handles it)
  const inlineStyle = isSettling ? undefined : {
    transform: `translateY(${translateY}px)`,
  };

  // Generate accessible label
  const ariaLabel = isRefreshing 
    ? 'Refreshing content' 
    : isArmed 
      ? 'Release to refresh' 
      : 'Pull down to refresh';

  return (
    <div
      ref={containerRef}
      className={`${styles.container} ${className}`}
      style={inlineStyle}
      role="status"
      aria-label={ariaLabel}
    >
      {isRefreshing ? (
        <Loader2 
          size={24} 
          className={`${styles.spinner} ${styles.spinning}`}
          strokeWidth={2.5}
        />
      ) : (
        <ArrowDown
          size={24}
          strokeWidth={2.5}
          style={{ transform: `rotate(${arrowRotation}deg)` }}
        />
      )}
    </div>
  );
};

export default PullToRefreshIndicator;
