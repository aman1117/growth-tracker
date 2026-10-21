import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeNotification } from '../test/fixtures/shell';
import {
  showNotificationPreview,
  useNotificationPreviewStore,
} from './useNotificationPreviewStore';

describe('useNotificationPreviewStore', () => {
  it('starts without a preview', () => {
    expect(useNotificationPreviewStore.getState().preview).toBeNull();
  });

  it('shows a preview and dismisses it', () => {
    const notification = makeNotification({ id: 7, title: 'New follower' });

    useNotificationPreviewStore.getState().showPreview(notification);
    expect(useNotificationPreviewStore.getState().preview).toBe(notification);

    useNotificationPreviewStore.getState().dismissPreview();
    expect(useNotificationPreviewStore.getState().preview).toBeNull();
  });

  it('keeps only the latest preview (latest wins)', () => {
    showNotificationPreview(makeNotification({ id: 1 }));
    showNotificationPreview(makeNotification({ id: 2, title: 'Newer' }));

    expect(useNotificationPreviewStore.getState().preview).toMatchObject({ id: 2, title: 'Newer' });
  });

  it('notifies subscribers when a preview arrives from outside React', () => {
    const { result } = renderHook(() => useNotificationPreviewStore((state) => state.preview?.id));
    expect(result.current).toBeUndefined();

    act(() => showNotificationPreview(makeNotification({ id: 42 })));
    expect(result.current).toBe(42);
  });
});
