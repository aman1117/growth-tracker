/**
 * Overlay History
 *
 * Lets overlays (modals, sheets, story viewer, panels) participate in browser
 * history so the system Back gesture / hardware Back button closes the top-most
 * overlay instead of leaving the page — the behaviour users expect from native apps.
 *
 * How it works:
 * - Opening an overlay pushes a history entry for the *same URL*, tagged with an id.
 *   The existing React Router state (key/idx/usr) is preserved, so the router treats
 *   the entry as the same location and does not remount the page.
 * - A user-initiated Back (popstate) dismisses every overlay above the entry we land on.
 * - Closing an overlay from the UI removes its entry with `history.back()`, so no
 *   "dead" Back presses are left behind.
 * - If an overlay is closed by navigating away, its buried entry becomes stale; when
 *   the user later lands on it, we transparently skip over it.
 */

const OVERLAY_STATE_KEY = '__overlayId';
const LOG_TAG = '[OverlayHistory]';

interface OverlayEntry {
  id: string;
  dismiss: () => void;
}

interface HistoryStateShape {
  idx?: number;
  [OVERLAY_STATE_KEY]?: string;
  [key: string]: unknown;
}

const stack: OverlayEntry[] = [];
const deferredOpens = new Map<string, () => void>();
let pendingProgrammaticPops = 0;
let lastKnownIdx: number | null = null;
let isListening = false;
let idCounter = 0;

const readState = (): HistoryStateShape | null =>
  (window.history.state as HistoryStateShape | null) ?? null;

const readIdx = (): number | null => {
  const idx = readState()?.idx;
  return typeof idx === 'number' ? idx : null;
};

const debug = (message: string, meta?: Record<string, unknown>) => {
  if (import.meta.env.DEV) {
    console.debug(LOG_TAG, message, meta ?? '');
  }
};

const flushDeferredOpens = () => {
  const opens = Array.from(deferredOpens.values());
  deferredOpens.clear();
  opens.forEach((open) => open());
};

/**
 * Safety net: if the browser never fires popstate for a programmatic Back
 * (e.g. the page is being unloaded), stop waiting so overlays keep working.
 */
let settleTimer: ReturnType<typeof setTimeout> | null = null;
const PROGRAMMATIC_POP_TIMEOUT_MS = 1000;

const programmaticBack = () => {
  pendingProgrammaticPops += 1;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (pendingProgrammaticPops > 0) {
      debug('programmatic back did not settle, recovering', { pendingProgrammaticPops });
      pendingProgrammaticPops = 0;
      flushDeferredOpens();
    }
  }, PROGRAMMATIC_POP_TIMEOUT_MS);
  window.history.back();
};

const handlePopState = () => {
  const idx = readIdx();
  const previousIdx = lastKnownIdx;
  lastKnownIdx = idx;

  if (pendingProgrammaticPops > 0) {
    pendingProgrammaticPops -= 1;
    if (pendingProgrammaticPops === 0) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      flushDeferredOpens();
    }
    return;
  }

  const currentOverlayId = readState()?.[OVERLAY_STATE_KEY];
  const position = currentOverlayId ? stack.findIndex((e) => e.id === currentOverlayId) : -1;

  // Dismiss every overlay that sits above the entry the user navigated to (LIFO)
  const dismissed = stack.splice(position + 1).reverse();
  dismissed.forEach((entry) => {
    debug('dismissed by back navigation', { id: entry.id });
    entry.dismiss();
  });

  // Landed (going back) on an entry whose overlay is already gone — e.g. the overlay
  // was closed by navigating to another page. Skip it so Back never feels "dead".
  // Forward travel is left alone: the entry shows the same page, so it is harmless.
  const travelledBack = previousIdx !== null && idx !== null && previousIdx > idx;
  if (currentOverlayId && position === -1 && travelledBack) {
    debug('skipping stale overlay entry', { id: currentOverlayId });
    programmaticBack();
  }
};

const ensureListening = () => {
  if (isListening || typeof window === 'undefined') return;
  isListening = true;
  lastKnownIdx = readIdx();
  window.addEventListener('popstate', handlePopState);
};

/** Creates a unique id for an overlay instance */
export const createOverlayId = (): string => {
  idCounter += 1;
  return `overlay-${Date.now().toString(36)}-${idCounter}`;
};

/**
 * Registers an open overlay and pushes its history entry.
 * If a programmatic Back is in flight, the push waits until it settles so
 * the browser does not pop the wrong entry.
 */
export const openOverlay = (id: string, dismiss: () => void): void => {
  ensureListening();

  const push = () => {
    window.history.pushState({ ...readState(), [OVERLAY_STATE_KEY]: id }, '');
    stack.push({ id, dismiss });
    debug('opened', { id, depth: stack.length });
  };

  if (pendingProgrammaticPops > 0) {
    deferredOpens.set(id, push);
  } else {
    push();
  }
};

/**
 * Unregisters an overlay that was closed by the app (close button, backdrop, Escape,
 * or unmount). Removes its history entry when it is still the current one.
 */
export const closeOverlay = (id: string): void => {
  if (deferredOpens.delete(id)) return;

  const position = stack.findIndex((e) => e.id === id);
  if (position === -1) return; // already dismissed via Back

  stack.splice(position, 1);
  debug('closed by app', { id, depth: stack.length });

  if (readState()?.[OVERLAY_STATE_KEY] === id) {
    programmaticBack();
  }
};

/** Keeps the internal history index in sync after router-driven navigations */
export const syncOverlayHistoryIndex = (): void => {
  lastKnownIdx = readIdx();
};

/** True when the current history entry belongs to an open overlay */
export const isOverlayEntryCurrent = (): boolean => {
  const id = readState()?.[OVERLAY_STATE_KEY];
  return !!id && stack.some((entry) => entry.id === id);
};
