/**
 * useSmartBack Hook
 *
 * Returns a "Back" handler that behaves like a native app:
 * - goes to the previous in-app screen when one exists;
 * - otherwise (deep link, fresh tab, PWA launch) replaces the current entry with a
 *   sensible parent route, so the button is never a dead end and never exits the app.
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { hasInAppHistory } from '../utils/navigation';

export function useSmartBack(fallbackPath: string = APP_ROUTES.HOME): () => void {
  const navigate = useNavigate();

  return useCallback(() => {
    if (hasInAppHistory()) {
      navigate(-1);
    } else {
      navigate(fallbackPath, { replace: true });
    }
  }, [navigate, fallbackPath]);
}
