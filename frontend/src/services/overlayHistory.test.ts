import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextPopState, trackPopstateListeners } from '../test/fixtures/core';

type OverlayHistory = typeof import('./overlayHistory');

const HOME_STATE = { key: 'home', idx: 0 };

let overlays: OverlayHistory;
let detachListeners: () => void;

beforeEach(async () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  // The overlay stack is module state: load a fresh copy per test and detach its listener after.
  detachListeners = trackPopstateListeners();
  vi.resetModules();
  overlays = await import('./overlayHistory');
  // React Router keeps a monotonically increasing `idx` in history.state.
  window.history.replaceState(HOME_STATE, '');
});

afterEach(() => detachListeners());

const currentOverlayId = () =>
  (window.history.state as { __overlayId?: string } | null)?.__overlayId;

/** Presses the browser Back button and waits until the browser has moved. */
async function pressBack() {
  const popped = nextPopState();
  window.history.back();
  await popped;
}

describe('overlay history', () => {
  it('creates unique overlay ids', () => {
    const ids = Array.from({ length: 5 }, () => overlays.createOverlayId());

    expect(new Set(ids).size).toBe(5);
    ids.forEach((id) => expect(id).toMatch(/^overlay-[0-9a-z]+-\d+$/));
  });

  it('pushes an entry for the same page that keeps the router state', () => {
    expect(overlays.isOverlayEntryCurrent()).toBe(false);

    overlays.openOverlay('sheet', vi.fn());

    expect(window.history.state).toEqual({ ...HOME_STATE, __overlayId: 'sheet' });
    expect(window.location.pathname).toBe('/');
    expect(overlays.isOverlayEntryCurrent()).toBe(true);
  });

  it('closes only the top-most overlay on Back', async () => {
    const closePanel = vi.fn();
    const closeConfirm = vi.fn();
    overlays.openOverlay('panel', closePanel);
    overlays.openOverlay('confirm', closeConfirm);

    await pressBack();

    expect(closeConfirm).toHaveBeenCalledTimes(1);
    expect(closePanel).not.toHaveBeenCalled();
    expect(currentOverlayId()).toBe('panel');
    expect(overlays.isOverlayEntryCurrent()).toBe(true);

    await pressBack();

    expect(closePanel).toHaveBeenCalledTimes(1);
    expect(window.history.state).toEqual(HOME_STATE);
    expect(overlays.isOverlayEntryCurrent()).toBe(false);
  });

  it('dismisses every overlay above the entry the user jumps back to, newest first', async () => {
    const closed: string[] = [];
    overlays.openOverlay('panel', () => closed.push('panel'));
    overlays.openOverlay('confirm', () => closed.push('confirm'));

    const popped = nextPopState();
    window.history.go(-2);
    await popped;

    expect(closed).toEqual(['confirm', 'panel']);
  });

  it('removes the entry of an overlay closed by the app without dismissing it again', async () => {
    const dismiss = vi.fn();
    overlays.openOverlay('sheet', dismiss);
    const back = vi.spyOn(window.history, 'back');

    const popped = nextPopState();
    overlays.closeOverlay('sheet');
    expect(back).toHaveBeenCalledTimes(1);
    await popped;

    expect(dismiss).not.toHaveBeenCalled();
    expect(window.history.state).toEqual(HOME_STATE);
    expect(overlays.isOverlayEntryCurrent()).toBe(false);
  });

  it('ignores closing overlays that are unknown or were already dismissed by Back', async () => {
    overlays.openOverlay('sheet', vi.fn());
    await pressBack();
    const back = vi.spyOn(window.history, 'back');

    overlays.closeOverlay('sheet');
    overlays.closeOverlay('never-opened');

    expect(back).not.toHaveBeenCalled();
  });

  it('unregisters a buried overlay without touching history', async () => {
    const closePanel = vi.fn();
    const closeConfirm = vi.fn();
    overlays.openOverlay('panel', closePanel);
    overlays.openOverlay('confirm', closeConfirm);
    const back = vi.spyOn(window.history, 'back');

    overlays.closeOverlay('panel');

    expect(back).not.toHaveBeenCalled();
    expect(currentOverlayId()).toBe('confirm');

    await pressBack();

    expect(closeConfirm).toHaveBeenCalledTimes(1);
    expect(closePanel).not.toHaveBeenCalled();
  });

  it('skips the stale entry of an overlay that was closed by navigating away', async () => {
    const dismiss = vi.fn();
    overlays.openOverlay('search', dismiss);
    // A link inside the overlay navigates: the router pushes a new page entry...
    window.history.pushState({ key: 'profile', idx: 1 }, '', '/user/bob');
    overlays.syncOverlayHistoryIndex();
    // ...and the overlay unmounts while its entry is buried below the new page.
    overlays.closeOverlay('search');

    await pressBack();
    // Landing on the dead overlay entry triggers one more (programmatic) Back.
    await nextPopState();

    expect(window.history.state).toEqual(HOME_STATE);
    expect(window.location.pathname).toBe('/');
    expect(dismiss).not.toHaveBeenCalled();
    expect(console.debug).toHaveBeenCalledWith('[OverlayHistory]', 'skipping stale overlay entry', {
      id: 'search',
    });
  });

  it('leaves a stale entry alone when travelling forward onto it', async () => {
    overlays.openOverlay('sheet', vi.fn());
    await pressBack();
    const back = vi.spyOn(window.history, 'back');

    const popped = nextPopState();
    window.history.forward();
    await popped;

    expect(currentOverlayId()).toBe('sheet');
    expect(overlays.isOverlayEntryCurrent()).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });

  it('waits for an in-flight programmatic Back before opening the next overlay', async () => {
    overlays.openOverlay('first', vi.fn());
    const popped = nextPopState();
    overlays.closeOverlay('first');

    overlays.openOverlay('second', vi.fn());
    // Pushing now would let the pending Back pop the new entry instead.
    expect(currentOverlayId()).toBe('first');

    await popped;

    expect(currentOverlayId()).toBe('second');
    expect(overlays.isOverlayEntryCurrent()).toBe(true);
  });

  it('drops a deferred open when the overlay closes before it was pushed', async () => {
    overlays.openOverlay('first', vi.fn());
    const popped = nextPopState();
    overlays.closeOverlay('first');
    overlays.openOverlay('second', vi.fn());

    overlays.closeOverlay('second');
    await popped;

    expect(window.history.state).toEqual(HOME_STATE);
    expect(overlays.isOverlayEntryCurrent()).toBe(false);
  });

  it('recovers when the browser never reports the programmatic Back', async () => {
    vi.useFakeTimers();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const closeSecond = vi.fn();
    overlays.openOverlay('first', vi.fn());
    overlays.closeOverlay('first');
    overlays.openOverlay('second', closeSecond);

    vi.advanceTimersByTime(999);
    expect(currentOverlayId()).toBe('first');

    vi.advanceTimersByTime(1);
    expect(currentOverlayId()).toBe('second');
    expect(console.debug).toHaveBeenCalledWith(
      '[OverlayHistory]',
      'programmatic back did not settle, recovering',
      { pendingProgrammaticPops: 1 }
    );

    // Later Back presses are handled as user navigation again.
    back.mockRestore();
    vi.useRealTimers();
    await pressBack();
    expect(closeSecond).toHaveBeenCalledTimes(1);
  });

  it('gives every programmatic Back its own recovery window', () => {
    vi.useFakeTimers();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    overlays.openOverlay('first', vi.fn());
    overlays.closeOverlay('first');
    vi.advanceTimersByTime(1000);

    overlays.openOverlay('second', vi.fn());
    expect(currentOverlayId()).toBe('second');
    overlays.closeOverlay('second');
    overlays.openOverlay('third', vi.fn());

    expect(back).toHaveBeenCalledTimes(2);
    expect(currentOverlayId()).toBe('second');
    vi.advanceTimersByTime(1000);
    expect(currentOverlayId()).toBe('third');
  });

  it('works on pages without router state', async () => {
    window.history.replaceState(null, '');
    const dismiss = vi.fn();

    overlays.openOverlay('sheet', dismiss);
    expect(window.history.state).toEqual({ __overlayId: 'sheet' });

    await pressBack();

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(overlays.isOverlayEntryCurrent()).toBe(false);
  });

  it('forgets open overlays and a Back that never arrived when reset, like a fresh page', async () => {
    const dismissStale = vi.fn();
    overlays.openOverlay('stale', dismissStale);
    overlays.openOverlay('left-open', vi.fn());
    // Closing from the app goes Back, but the browser never reports it (the page went away)
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    overlays.closeOverlay('left-open');
    back.mockRestore();

    overlays.resetOverlayHistory();
    const dismissFresh = vi.fn();
    overlays.openOverlay('fresh', dismissFresh);

    // Opened at once instead of waiting behind the lost Back
    expect(currentOverlayId()).toBe('fresh');
    await pressBack();
    // Back closes the new overlay only: the old ones were forgotten
    expect(dismissFresh).toHaveBeenCalledTimes(1);
    expect(dismissStale).not.toHaveBeenCalled();
  });
});
