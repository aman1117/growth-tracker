/**
 * useBackDismiss Hook
 *
 * Makes an overlay close on the browser / hardware Back action (Android back button,
 * iOS edge-swipe in standalone PWAs, desktop Back) instead of leaving the page.
 *
 * @example
 * useBackDismiss(isOpen, onClose);
 */

import { useEffect, useRef } from 'react';

import { closeOverlay, createOverlayId, openOverlay } from '../services/overlayHistory';

export function useBackDismiss(isOpen: boolean, onDismiss: () => void): void {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!isOpen) return;

    const id = createOverlayId();
    // Deferred so React StrictMode's mount → unmount → mount cycle doesn't push
    // and immediately pop a history entry.
    const timer = window.setTimeout(() => {
      openOverlay(id, () => onDismissRef.current());
    }, 0);

    return () => {
      window.clearTimeout(timer);
      closeOverlay(id);
    };
  }, [isOpen]);
}
