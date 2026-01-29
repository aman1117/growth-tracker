/**
 * Toast Store
 *
 * Global toast notification state management.
 */

import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (message: string, type: ToastType, duration?: number) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

let toastId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (message, type, duration = 3000) => {
    const id = `toast-${++toastId}`;
    const toast: Toast = { id, message, type, duration };

    set((state) => ({
      toasts: [...state.toasts, toast],
    }));

    // Auto-remove toast after duration
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, duration);
    }
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  clearToasts: () => set({ toasts: [] }),
}));

/**
 * Convenience function to show a toast
 */
export const showToast = (message: string, type: ToastType = 'info', duration?: number) => {
  useToastStore.getState().addToast(message, type, duration);
};

/**
 * Convenience function to show success toast
 */
export const showSuccess = (message: string, duration?: number) => {
  showToast(message, 'success', duration);
};

/**
 * Convenience function to show error toast
 */
export const showError = (message: string, duration?: number) => {
  showToast(message, 'error', duration);
};
