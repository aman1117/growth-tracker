import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RegisterSWOptions } from 'virtual:pwa-register/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gl } from '../services/goodlogs';
import { PWAUpdatePrompt } from './PWAUpdatePrompt';

const sw = vi.hoisted(() => ({
  /** Whether a new service worker is waiting when the prompt mounts */
  needRefresh: false,
  updateServiceWorker: vi.fn(),
  options: undefined as RegisterSWOptions | undefined,
}));

vi.mock('virtual:pwa-register/react', async () => {
  const { useState } = await import('react');
  return {
    useRegisterSW: (options?: RegisterSWOptions) => {
      sw.options = options;
      return {
        needRefresh: useState(sw.needRefresh),
        offlineReady: useState(false),
        updateServiceWorker: sw.updateServiceWorker,
      };
    },
  };
});

describe('PWAUpdatePrompt', () => {
  beforeEach(() => {
    sw.needRefresh = false;
    sw.options = undefined;
  });

  it('stays hidden until a new version is waiting', () => {
    render(<PWAUpdatePrompt />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('activates the waiting version on "Refresh"', async () => {
    sw.needRefresh = true;
    const user = userEvent.setup();
    render(<PWAUpdatePrompt />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('A fresh update is ready');
    expect(notice).toHaveTextContent('Refresh to get the latest improvements.');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(sw.updateServiceWorker).toHaveBeenCalledWith(true);
    expect(gl.track).toHaveBeenCalledWith('pwa_update_accepted');
  });

  it('can be dismissed', async () => {
    sw.needRefresh = true;
    const user = userEvent.setup();
    render(<PWAUpdatePrompt />);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(gl.track).toHaveBeenCalledWith('pwa_update_dismissed');
    expect(sw.updateServiceWorker).not.toHaveBeenCalled();
  });

  describe('service worker registration', () => {
    it('checks for updates every hour once registered', () => {
      vi.useFakeTimers();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const update = vi.fn();
      render(<PWAUpdatePrompt />);

      act(() =>
        sw.options?.onRegisteredSW?.('/sw.js', { update } as unknown as ServiceWorkerRegistration)
      );
      expect(log).toHaveBeenCalledWith('SW registered:', '/sw.js');

      vi.advanceTimersByTime(60 * 60 * 1000 - 1);
      expect(update).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(update).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(update).toHaveBeenCalledTimes(2);
    });

    it('skips the periodic check when no registration is available', () => {
      vi.useFakeTimers();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      render(<PWAUpdatePrompt />);

      act(() => sw.options?.onRegisteredSW?.('/sw.js', undefined));

      expect(log).toHaveBeenCalledWith('SW registered:', '/sw.js');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('logs registration errors', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = new Error('Registration failed');
      render(<PWAUpdatePrompt />);

      act(() => sw.options?.onRegisterError?.(error));

      expect(consoleError).toHaveBeenCalledWith('SW registration error:', error);
    });
  });
});
