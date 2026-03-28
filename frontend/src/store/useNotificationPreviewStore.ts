/**
 * Notification Preview Store
 *
 * Manages the notification preview toast state.
 * Latest-wins: only one preview at a time; new notifications replace the current one.
 */

import { create } from 'zustand';

import type { Notification } from '../types';

interface NotificationPreviewState {
  preview: Notification | null;
  showPreview: (notification: Notification) => void;
  dismissPreview: () => void;
}

export const useNotificationPreviewStore = create<NotificationPreviewState>((set) => ({
  preview: null,

  showPreview: (notification) => {
    set({ preview: notification });
  },

  dismissPreview: () => {
    set({ preview: null });
  },
}));

/**
 * Convenience function to show a notification preview toast.
 * Can be called from anywhere (e.g., WebSocket handler).
 */
export const showNotificationPreview = (notification: Notification) => {
  useNotificationPreviewStore.getState().showPreview(notification);
};
