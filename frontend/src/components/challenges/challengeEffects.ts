/**
 * Logging and navigation helpers shared by the Challenges screens.
 */

import { gl } from '../../services/goodlogs';
import { isOverlayEntryCurrent } from '../../services/overlayHistory';
import { getErrorCode, getErrorStatus } from '../../utils/challenges';

type LogValue = string | number | boolean | null | undefined;

export interface ChallengeFailureContext {
  /** What the screen does about it, e.g. "show_retry" or "rollback" */
  recovery: string;
  [key: string]: LogValue;
}

/**
 * Logs a failed challenge request — tagged in the console for debugging and as a GoodLogs
 * warning — with ids, error codes and statuses only (never titles, usernames or invite codes).
 */
export function logChallengeFailure(
  event: string,
  error: unknown,
  context: ChallengeFailureContext
): void {
  const metadata = { ...context, errorCode: getErrorCode(error), status: getErrorStatus(error) };
  console.warn(`[Challenges] ${event}`, metadata);
  gl.warn(`challenge_${event}`, { metadata });
}

/** Longest wait for an overlay's history entry to go away before navigating anyway */
export const OVERLAY_CLOSE_TIMEOUT_MS = 500;

/**
 * Runs `go` once the open overlay (dialog, sheet) has removed its history entry, so that a
 * `replace` navigation replaces the screen's own entry rather than the overlay's — otherwise
 * Back would lead to the screen that was just left (e.g. a deleted challenge).
 * Call it right before closing the overlay.
 */
export function afterOverlayCloses(go: () => void): void {
  if (!isOverlayEntryCurrent()) {
    go();
    return;
  }

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', finish);
    clearTimeout(timer);
    go();
  };
  window.addEventListener('popstate', finish);
  const timer = setTimeout(finish, OVERLAY_CLOSE_TIMEOUT_MS);
}
