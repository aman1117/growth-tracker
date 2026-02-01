/**
 * PullToRefreshWrapper Component
 *
 * Twitter-style pull-to-refresh wrapper.
 * Uses React state for rendering, Web Animations API for settle animation.
 */

import React, { useEffect, useRef } from 'react';

import { usePullToRefresh } from '../../../hooks/usePullToRefresh';
import { PullToRefreshIndicator } from '../PullToRefreshIndicator';

import styles from './PullToRefreshWrapper.module.css';

export interface PullToRefreshWrapperProps {
  children: React.ReactNode;
  onRefresh: () => Promise<void>;
  disabled?: boolean;
  threshold?: number;
  maxPull?: number;
  className?: string;
}

const DEFAULT_THRESHOLD = 72;
const DEFAULT_MAX_PULL = 140;
const RESISTANCE_FACTOR = 0.5;
const ANIMATION_DURATION = 200;

export const PullToRefreshWrapper: React.FC<PullToRefreshWrapperProps> = ({
  children,
  onRefresh,
  disabled = false,
  threshold = DEFAULT_THRESHOLD,
  maxPull = DEFAULT_MAX_PULL,
  className = '',
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const isAnimatingRef = useRef(false);
  const animationRef = useRef<Animation | null>(null);

  const {
    state,
    isPulling,
    isRefreshing,
    pullOffset,
  } = usePullToRefresh({
    onRefresh,
    disabled,
    threshold,
    maxPull,
    resistanceFactor: RESISTANCE_FACTOR,
  });

  const isSettling = state === 'settling';
  const isActive = isPulling || isRefreshing;

  // Calculate transform for content
  const contentTransform = isPulling 
    ? pullOffset 
    : isRefreshing 
      ? threshold * RESISTANCE_FACTOR 
      : 0;

  // Handle settle animation
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    if (isSettling && !isAnimatingRef.current) {
      isAnimatingRef.current = true;
      
      // Get current transform
      const computedStyle = getComputedStyle(content);
      const matrix = new DOMMatrix(computedStyle.transform);
      const currentY = matrix.m42 || 0;

      if (currentY > 0) {
        // Cancel any existing animation
        if (animationRef.current) {
          animationRef.current.cancel();
        }
        
        animationRef.current = content.animate(
          [
            { transform: `translateY(${currentY}px)` },
            { transform: 'translateY(0)' }
          ],
          {
            duration: ANIMATION_DURATION,
            easing: 'cubic-bezier(0.4, 0, 1, 1)',
            fill: 'forwards'
          }
        );

        animationRef.current.onfinish = () => {
          content.style.transform = '';
          isAnimatingRef.current = false;
          animationRef.current = null;
        };
      } else {
        isAnimatingRef.current = false;
      }
    }
    
    // Cleanup animation on unmount
    return () => {
      if (animationRef.current) {
        animationRef.current.cancel();
        animationRef.current = null;
      }
    };
  }, [isSettling]);

  // Reset animation flag when becoming active
  useEffect(() => {
    if (isActive) {
      isAnimatingRef.current = false;
    }
  }, [isActive]);

  // Inline style for content (not during settle animation)
  const contentStyle = isSettling ? undefined : {
    transform: contentTransform > 0 ? `translateY(${contentTransform}px)` : undefined,
  };

  return (
    <div
      className={`${styles.wrapper} ${className}`}
      aria-busy={isRefreshing}
      aria-live="polite"
    >
      <PullToRefreshIndicator
        state={state}
        pullOffset={pullOffset}
        threshold={threshold * RESISTANCE_FACTOR}
      />

      <div 
        ref={contentRef} 
        className={styles.content}
        style={contentStyle}
      >
        {children}
      </div>
    </div>
  );
};

export default PullToRefreshWrapper;
