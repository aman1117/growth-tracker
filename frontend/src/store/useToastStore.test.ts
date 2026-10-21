import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { showError, showSuccess, showToast, useToastStore } from './useToastStore';

const toasts = () => useToastStore.getState().toasts;

describe('useToastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('adds a toast with a unique id and the default 3s duration', () => {
    useToastStore.getState().addToast('Saved', 'success');
    useToastStore.getState().addToast('Saved again', 'success');

    expect(toasts()).toEqual([
      {
        id: expect.stringMatching(/^toast-\d+$/),
        message: 'Saved',
        type: 'success',
        duration: 3000,
      },
      expect.objectContaining({ message: 'Saved again' }),
    ]);
    expect(toasts()[0].id).not.toBe(toasts()[1].id);
  });

  it('removes a toast automatically once its duration has passed', () => {
    useToastStore.getState().addToast('Quick', 'info', 1000);
    useToastStore.getState().addToast('Slow', 'info', 5000);

    vi.advanceTimersByTime(999);
    expect(toasts().map((t) => t.message)).toEqual(['Quick', 'Slow']);

    vi.advanceTimersByTime(1);
    expect(toasts().map((t) => t.message)).toEqual(['Slow']);

    vi.advanceTimersByTime(4000);
    expect(toasts()).toEqual([]);
  });

  it('keeps a toast with duration 0 until it is removed manually', () => {
    useToastStore.getState().addToast('Sticky', 'error', 0);
    vi.advanceTimersByTime(60_000);
    expect(toasts()).toHaveLength(1);

    useToastStore.getState().removeToast(toasts()[0].id);
    expect(toasts()).toEqual([]);
  });

  it('removes only the toast with the given id', () => {
    useToastStore.getState().addToast('One', 'info', 0);
    useToastStore.getState().addToast('Two', 'info', 0);

    useToastStore.getState().removeToast(toasts()[0].id);
    expect(toasts().map((t) => t.message)).toEqual(['Two']);

    useToastStore.getState().removeToast('missing-id');
    expect(toasts().map((t) => t.message)).toEqual(['Two']);
  });

  it('clears every toast at once', () => {
    useToastStore.getState().addToast('One', 'info');
    useToastStore.getState().addToast('Two', 'error');

    useToastStore.getState().clearToasts();
    expect(toasts()).toEqual([]);
  });

  it('auto-dismissal after a manual clear is harmless', () => {
    useToastStore.getState().addToast('Gone', 'info', 1000);
    useToastStore.getState().clearToasts();
    useToastStore.getState().addToast('Fresh', 'info', 0);

    vi.advanceTimersByTime(1000);
    expect(toasts().map((t) => t.message)).toEqual(['Fresh']);
  });

  describe('convenience helpers', () => {
    it('showToast defaults to an info toast', () => {
      showToast('Heads up');
      expect(toasts()).toEqual([
        expect.objectContaining({ message: 'Heads up', type: 'info', duration: 3000 }),
      ]);
    });

    it('showSuccess and showError set the type and pass the duration through', () => {
      showSuccess('Done', 1500);
      showError('Failed', 0);

      expect(toasts()).toEqual([
        expect.objectContaining({ message: 'Done', type: 'success', duration: 1500 }),
        expect.objectContaining({ message: 'Failed', type: 'error', duration: 0 }),
      ]);
    });
  });

  it('re-renders subscribed components when toasts change', () => {
    const { result } = renderHook(() => useToastStore((state) => state.toasts.length));
    expect(result.current).toBe(0);

    act(() => showToast('Hello'));
    expect(result.current).toBe(1);

    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBe(0);
  });
});
