/**
 * useOverlayAwareNavigate Hook
 *
 * Drop-in replacement for `useNavigate()` for links that live inside overlays
 * (modals, sheets, panels, search). When the current history entry belongs to an
 * open overlay, the navigation *replaces* that entry, so pressing Back on the new
 * screen returns straight to the page underneath — not to an invisible overlay step.
 */

import { useCallback } from 'react';
import { type NavigateOptions, useNavigate } from 'react-router-dom';

import { isOverlayEntryCurrent } from '../services/overlayHistory';

export function useOverlayAwareNavigate(): (to: string, options?: NavigateOptions) => void {
  const navigate = useNavigate();

  return useCallback(
    (to: string, options?: NavigateOptions) => {
      const replace = options?.replace ?? isOverlayEntryCurrent();
      navigate(to, { ...options, replace });
    },
    [navigate]
  );
}
