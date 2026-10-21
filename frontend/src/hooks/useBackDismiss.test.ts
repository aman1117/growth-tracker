import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextPopState, trackPopstateListeners } from '../test/fixtures/core';

type UseBackDismiss = typeof import('./useBackDismiss').useBackDismiss;

const PAGE_STATE = { key: 'page', idx: 0 };

let useBackDismiss: UseBackDismiss;
let detachListeners: () => void;

beforeEach(async () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  // Fresh overlay-history singleton per test (see services/overlayHistory.test.ts).
  detachListeners = trackPopstateListeners();
  vi.resetModules();
  ({ useBackDismiss } = await import('./useBackDismiss'));
  window.history.replaceState(PAGE_STATE, '');
});

afterEach(() => detachListeners());

const overlayEntry = () => (window.history.state as { __overlayId?: string } | null)?.__overlayId;

async function pressBack() {
  const popped = nextPopState();
  window.history.back();
  await popped;
}

function renderOverlay(isOpen: boolean, onDismiss = vi.fn()) {
  const hook = renderHook(({ open, dismiss }) => useBackDismiss(open, dismiss), {
    initialProps: { open: isOpen, dismiss: onDismiss },
  });
  return { ...hook, onDismiss };
}

describe('useBackDismiss', () => {
  it('adds a history entry for the open overlay and closes it on Back', async () => {
    const { onDismiss } = renderOverlay(true);
    await waitFor(() => expect(overlayEntry()).toMatch(/^overlay-/));

    await pressBack();

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(window.history.state).toEqual(PAGE_STATE);
  });

  it('calls the latest dismiss callback', async () => {
    const { rerender, onDismiss } = renderOverlay(true);
    await waitFor(() => expect(overlayEntry()).toBeDefined());
    const latest = vi.fn();
    rerender({ open: true, dismiss: latest });

    await pressBack();

    expect(onDismiss).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('removes its entry, without calling onDismiss, when the app closes the overlay', async () => {
    const { rerender, onDismiss } = renderOverlay(true);
    await waitFor(() => expect(overlayEntry()).toBeDefined());

    const popped = nextPopState();
    rerender({ open: false, dismiss: onDismiss });
    await popped;

    expect(window.history.state).toEqual(PAGE_STATE);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('leaves history alone while the overlay is closed', async () => {
    renderOverlay(false);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(window.history.state).toEqual(PAGE_STATE);
  });

  it('does not push an entry when unmounted right after mounting (StrictMode double mount)', async () => {
    const { unmount } = renderOverlay(true);
    unmount();

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(window.history.state).toEqual(PAGE_STATE);
  });
});
