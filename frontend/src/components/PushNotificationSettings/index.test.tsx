import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gl } from '../../services/goodlogs';
import { pushService } from '../../services/pushService';
import { usePushStore } from '../../store/usePushStore';
import {
  deferred,
  DESKTOP_CHROME_UA,
  pushPreferences,
  setPushEnvironment,
  stubUserAgent,
} from '../../test/fixtures/settings';
import type { PreferencesResponse, UpdatePreferencesRequest } from '../../types/push';
import { PushNotificationSettings } from './index';

vi.mock('../../services/pushService');

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function renderSettings({ withToast = true } = {}) {
  const onToast = vi.fn();
  const view = render(<PushNotificationSettings onToast={withToast ? onToast : undefined} />);
  return { user: userEvent.setup(), onToast, unmount: view.unmount };
}

/** The server accepts every change and echoes the merged preferences back. */
function serverSaves(current = pushPreferences()) {
  vi.mocked(pushService.updatePreferences).mockImplementation(
    async (updates: UpdatePreferencesRequest) => ({
      success: true,
      preferences: {
        ...current,
        ...updates,
        preferences: { ...current.preferences, ...updates.preferences },
      } as typeof current,
    })
  );
}

const typesHeader = () => screen.getByRole('button', { name: /^Notification types/ });
const quietHeader = () => screen.getByRole('button', { name: /^Quiet hours/ });

describe('PushNotificationSettings', () => {
  beforeEach(() => {
    stubUserAgent(DESKTOP_CHROME_UA);
    // Modal logs overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  describe('before subscribing', () => {
    it('explains that this browser cannot receive push notifications', () => {
      setPushEnvironment({ supported: false });
      renderSettings();

      expect(screen.getByRole('status')).toHaveTextContent(
        "Push notifications aren't supported in this browser."
      );
    });

    it('shows how to unblock notifications when permission is denied', async () => {
      setPushEnvironment({ permission: 'denied' });
      const { user } = renderSettings();

      await user.click(
        screen.getByRole('button', { name: /Notifications blocked\s*Tap to see how/ })
      );
      const guide = screen.getByRole('dialog', { name: 'Turn on notifications' });

      await user.click(within(guide).getByRole('button', { name: 'Got it' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('enables notifications and then shows the preferences', async () => {
      setPushEnvironment({ permission: 'default' });
      const request = deferred<{ success: boolean }>();
      vi.mocked(pushService.subscribe).mockReturnValue(request.promise);
      const { user } = renderSettings();

      expect(screen.getByText('Get notified about likes, badges, and streaks')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Enable' }));

      expect(screen.getByRole('button', { name: 'Enabling…' })).toBeDisabled();
      request.resolve({ success: true });

      expect(
        await screen.findByRole('button', { name: /^Notification types/ })
      ).toBeInTheDocument();
      expect(quietHeader()).toBeInTheDocument();
      expect(pushService.getPreferences).toHaveBeenCalled();
    });

    it('shows why enabling failed and lets the user try again', async () => {
      setPushEnvironment({ permission: 'default' });
      vi.mocked(pushService.subscribe).mockResolvedValue({
        success: false,
        message: 'Notification permission not granted',
      });
      const { user } = renderSettings();

      await user.click(screen.getByRole('button', { name: 'Enable' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Notification permission not granted'
      );
      expect(screen.getByRole('button', { name: 'Enable' })).toBeEnabled();
    });
  });

  describe('when subscribed', () => {
    it('shows an error from the push store above the preferences', async () => {
      setPushEnvironment({ permission: 'granted', subscribed: true });
      renderSettings();
      await screen.findByRole('button', { name: /^Notification types/ });

      act(() => usePushStore.setState({ error: 'Failed to unsubscribe' }));

      expect(screen.getByRole('alert')).toHaveTextContent('Failed to unsubscribe');
    });

    it('clears the error when the settings close', async () => {
      setPushEnvironment({ permission: 'granted', subscribed: true });
      const { unmount } = renderSettings();
      await screen.findByRole('button', { name: /^Notification types/ });
      act(() => usePushStore.setState({ error: 'Failed to unsubscribe' }));

      unmount();

      expect(usePushStore.getState().error).toBeNull();
    });
  });

  describe('notification types', () => {
    it('saves a type as soon as its switch is flipped', async () => {
      setPushEnvironment({ permission: 'granted', subscribed: true });
      serverSaves();
      const { user, onToast } = renderSettings();

      await user.click(await screen.findByRole('button', { name: /^Notification types/ }));
      expect(typesHeader()).toHaveAttribute('aria-expanded', 'true');
      await user.click(screen.getByRole('switch', { name: 'Likes' }));

      expect(pushService.updatePreferences).toHaveBeenCalledWith({
        preferences: { like_received: false },
      });
      await waitFor(() => expect(onToast).toHaveBeenCalledWith('Preferences saved', 'success'));
      expect(screen.getByRole('switch', { name: 'Likes' })).not.toBeChecked();
      expect(typesHeader()).toHaveTextContent('3 of 4 on');
      expect(gl.track).toHaveBeenCalledWith('push_preferences_updated');

      await user.click(typesHeader());
      expect(typesHeader()).toHaveAttribute('aria-expanded', 'false');
    });

    it('flips the switch right away and puts it back if saving fails', async () => {
      setPushEnvironment({ permission: 'granted', subscribed: true });
      const request = deferred<PreferencesResponse>();
      vi.mocked(pushService.updatePreferences).mockReturnValue(request.promise);
      const { user, onToast } = renderSettings();
      await user.click(await screen.findByRole('button', { name: /^Notification types/ }));

      await user.click(screen.getByRole('switch', { name: 'Badges' }));
      expect(screen.getByRole('switch', { name: 'Badges' })).not.toBeChecked();

      request.reject(new Error('Network error'));

      await waitFor(() => expect(screen.getByRole('switch', { name: 'Badges' })).toBeChecked());
      expect(typesHeader()).toHaveTextContent('4 of 4 on');
      expect(onToast).not.toHaveBeenCalled();
    });

    it('works without a toast handler', async () => {
      setPushEnvironment({ permission: 'granted', subscribed: true });
      serverSaves();
      const { user } = renderSettings({ withToast: false });
      await user.click(await screen.findByRole('button', { name: /^Notification types/ }));

      await user.click(screen.getByRole('switch', { name: 'Streak reminders' }));

      await waitFor(() =>
        expect(screen.getByRole('switch', { name: 'Streak reminders' })).not.toBeChecked()
      );
    });
  });

  describe('quiet hours', () => {
    const quietWindow = pushPreferences({
      quiet_hours_enabled: true,
      quiet_start: '22:00',
      quiet_end: '07:00',
    });

    it('turns quiet hours on with the default window', async () => {
      setPushEnvironment({ permission: 'granted', subscribed: true });
      serverSaves();
      const { user, onToast } = renderSettings();

      await user.click(await screen.findByRole('button', { name: /^Quiet hours/ }));
      expect(quietHeader()).toHaveTextContent('Off');
      await user.click(screen.getByRole('switch', { name: 'Pause notifications' }));

      expect(pushService.updatePreferences).toHaveBeenCalledWith({
        quiet_hours_enabled: true,
        quiet_start: '22:00',
        quiet_end: '08:00',
        timezone: TIMEZONE,
      });
      await waitFor(() => expect(onToast).toHaveBeenCalledWith('Preferences saved', 'success'));
      expect(quietHeader()).toHaveTextContent('22:00 – 08:00');
      expect(screen.getByRole('combobox', { name: 'From' })).toHaveValue('22:00');
      expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('08:00');
    });

    it('stays off when the server rejects the change', async () => {
      setPushEnvironment({ permission: 'granted', subscribed: true });
      vi.mocked(pushService.updatePreferences).mockResolvedValue({ success: false });
      const { user, onToast } = renderSettings();
      await user.click(await screen.findByRole('button', { name: /^Quiet hours/ }));

      await user.click(screen.getByRole('switch', { name: 'Pause notifications' }));

      await waitFor(() =>
        expect(screen.getByRole('switch', { name: 'Pause notifications' })).not.toBeChecked()
      );
      expect(quietHeader()).toHaveTextContent('Off');
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(onToast).not.toHaveBeenCalled();
    });

    it('starts from the saved window', async () => {
      setPushEnvironment({
        permission: 'granted',
        subscribed: true,
        preferences: pushPreferences({
          quiet_hours_enabled: true,
          quiet_start: '23:00',
          quiet_end: '06:00',
        }),
      });
      const { user } = renderSettings();

      await user.click(await screen.findByRole('button', { name: /^Quiet hours/ }));

      expect(quietHeader()).toHaveTextContent('23:00 – 06:00');
      expect(screen.getByRole('combobox', { name: 'From' })).toHaveValue('23:00');
      expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('06:00');
    });

    it('saves time changes once, after the user stops changing them', async () => {
      setPushEnvironment({ permission: 'granted', subscribed: true, preferences: quietWindow });
      serverSaves(quietWindow);
      const { user, onToast } = renderSettings();
      await user.click(await screen.findByRole('button', { name: /^Quiet hours/ }));

      vi.useFakeTimers();
      fireEvent.change(screen.getByRole('combobox', { name: 'From' }), {
        target: { value: '21:00' },
      });
      await act(() => vi.advanceTimersByTimeAsync(300));
      fireEvent.change(screen.getByRole('combobox', { name: 'To' }), {
        target: { value: '06:00' },
      });

      expect(quietHeader()).toHaveTextContent('21:00 – 06:00');
      await act(() => vi.advanceTimersByTimeAsync(499));
      expect(pushService.updatePreferences).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(1));

      expect(pushService.updatePreferences).toHaveBeenCalledTimes(1);
      expect(pushService.updatePreferences).toHaveBeenCalledWith({
        quiet_start: '21:00',
        quiet_end: '06:00',
        timezone: TIMEZONE,
      });
      expect(onToast).toHaveBeenCalledWith('Preferences saved', 'success');
    });

    it('puts the previous window back when saving the times fails', async () => {
      setPushEnvironment({ permission: 'granted', subscribed: true, preferences: quietWindow });
      vi.mocked(pushService.updatePreferences).mockResolvedValue({ success: false });
      const { user, onToast } = renderSettings();
      await user.click(await screen.findByRole('button', { name: /^Quiet hours/ }));

      vi.useFakeTimers();
      fireEvent.change(screen.getByRole('combobox', { name: 'From' }), {
        target: { value: '20:00' },
      });
      await act(() => vi.advanceTimersByTimeAsync(500));

      expect(pushService.updatePreferences).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('combobox', { name: 'From' })).toHaveValue('22:00');
      expect(quietHeader()).toHaveTextContent('22:00 – 07:00');
      expect(onToast).not.toHaveBeenCalled();
    });

    it('drops a pending time change when the settings close', async () => {
      setPushEnvironment({ permission: 'granted', subscribed: true, preferences: quietWindow });
      const { user, unmount } = renderSettings();
      await user.click(await screen.findByRole('button', { name: /^Quiet hours/ }));

      vi.useFakeTimers();
      fireEvent.change(screen.getByRole('combobox', { name: 'To' }), {
        target: { value: '09:00' },
      });
      unmount();
      await act(() => vi.advanceTimersByTimeAsync(1000));

      expect(pushService.updatePreferences).not.toHaveBeenCalled();
    });
  });
});
