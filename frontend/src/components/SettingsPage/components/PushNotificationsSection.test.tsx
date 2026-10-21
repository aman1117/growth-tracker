import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gl } from '../../../services/goodlogs';
import { pushService } from '../../../services/pushService';
import {
  deferred,
  DESKTOP_CHROME_UA,
  IPHONE_SAFARI_UA,
  setPushEnvironment,
  stubInstalledApp,
  stubUserAgent,
} from '../../../test/fixtures/settings';
import { PushNotificationsSection } from './PushNotificationsSection';

vi.mock('../../../services/pushService');

function renderSection() {
  const onToast = vi.fn();
  render(<PushNotificationsSection onToast={onToast} />);
  return { user: userEvent.setup(), onToast };
}

const pushSwitch = () => screen.getByRole('switch', { name: 'Push notifications' });

/** The browser grants permission and creates a subscription when the user subscribes. */
function subscribeSucceeds() {
  vi.mocked(pushService.subscribe).mockImplementation(async () => {
    vi.mocked(pushService.getPermissionState).mockReturnValue('granted');
    vi.mocked(pushService.getExistingSubscription).mockResolvedValue({} as PushSubscription);
    return { success: true };
  });
}

describe('PushNotificationsSection', () => {
  beforeEach(() => {
    stubUserAgent(DESKTOP_CHROME_UA);
    // Modal logs overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  describe('when the browser cannot do web push', () => {
    it('renders nothing outside iOS', () => {
      setPushEnvironment({ supported: false });
      renderSection();

      expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
    });

    it('renders nothing in an installed iOS app', () => {
      stubUserAgent(IPHONE_SAFARI_UA);
      stubInstalledApp();
      setPushEnvironment({ supported: false });
      renderSection();

      expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
    });

    it('tells iOS Safari users to add the app to the Home Screen first', async () => {
      stubUserAgent(IPHONE_SAFARI_UA);
      setPushEnvironment({ supported: false });
      const { user } = renderSection();

      const section = screen.getByRole('region', { name: 'Notifications' });
      expect(within(section).queryByRole('switch')).not.toBeInTheDocument();
      await user.click(
        within(section).getByRole('button', {
          name: /Push notifications\s*Add Growth Tracker to your Home Screen to turn them on/,
        })
      );

      const guide = screen.getByRole('dialog', { name: 'Turn on notifications on iOS' });
      expect(within(guide).getAllByRole('listitem')[0]).toHaveTextContent(
        'Tap the Share button in Safari'
      );

      await user.click(within(guide).getByRole('button', { name: 'Got it' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('explains how to unblock notifications when permission is denied', async () => {
    setPushEnvironment({ permission: 'denied' });
    const { user } = renderSection();

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: /Push notifications\s*Blocked · Tap to see how to turn them on/,
      })
    );

    expect(screen.getByRole('dialog', { name: 'Turn on notifications' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('turns notifications on for this device', async () => {
    setPushEnvironment({ permission: 'default' });
    subscribeSucceeds();
    const { user, onToast } = renderSection();

    expect(pushSwitch()).not.toBeChecked();
    expect(pushSwitch()).toHaveAccessibleDescription(
      'Likes, badges and streak reminders on this device'
    );
    expect(screen.queryByRole('button', { name: /Notification types/ })).not.toBeInTheDocument();

    await user.click(pushSwitch());

    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Notifications turned on', 'success'));
    expect(pushSwitch()).toBeChecked();
    expect(pushSwitch()).toHaveAccessibleDescription('On for this device');
    expect(await screen.findByRole('button', { name: /Notification types/ })).toBeInTheDocument();
    expect(gl.track).toHaveBeenCalledWith('push_subscribed');
  });

  it('reports a failed subscribe and leaves the switch off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setPushEnvironment({ permission: 'default' });
    vi.mocked(pushService.subscribe).mockResolvedValue({
      success: false,
      message: 'Notification permission not granted',
    });
    const { user, onToast } = renderSection();

    await user.click(pushSwitch());

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        "Couldn't turn on notifications. Check your browser permissions.",
        'error'
      )
    );
    expect(pushSwitch()).not.toBeChecked();
    expect(warn).toHaveBeenCalledWith('[Settings] Push notification toggle failed', {
      wasSubscribed: false,
    });
  });

  it('turns notifications off and hides the preferences', async () => {
    setPushEnvironment({ permission: 'granted', subscribed: true });
    vi.mocked(pushService.unsubscribe).mockResolvedValue({ success: true });
    const { user, onToast } = renderSection();

    expect(await screen.findByRole('button', { name: /Notification types/ })).toBeInTheDocument();
    expect(pushSwitch()).toBeChecked();
    expect(pushSwitch()).toHaveAccessibleDescription('On for this device');

    await user.click(pushSwitch());

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('Notifications turned off', 'success')
    );
    expect(pushSwitch()).not.toBeChecked();
    expect(screen.queryByRole('button', { name: /Notification types/ })).not.toBeInTheDocument();
  });

  it('reports a failed unsubscribe and stays on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setPushEnvironment({ permission: 'granted', subscribed: true });
    vi.mocked(pushService.unsubscribe).mockRejectedValue(new Error('Network error'));
    const { user, onToast } = renderSection();
    await screen.findByRole('button', { name: /Notification types/ });

    await user.click(pushSwitch());

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("Couldn't turn off notifications. Try again.", 'error')
    );
    expect(pushSwitch()).toBeChecked();
  });

  it('keeps keyboard focus on the switch and ignores input while saving', async () => {
    setPushEnvironment({ permission: 'default' });
    const request = deferred<{ success: boolean }>();
    vi.mocked(pushService.subscribe).mockReturnValue(request.promise);
    const { user, onToast } = renderSection();

    await user.tab();
    expect(pushSwitch()).toHaveFocus();
    await user.keyboard(' ');

    expect(pushSwitch()).toHaveAttribute('aria-busy', 'true');
    expect(pushSwitch()).toHaveFocus();
    await user.keyboard(' ');
    await user.click(pushSwitch());
    expect(pushService.subscribe).toHaveBeenCalledTimes(1);

    request.resolve({ success: true });
    await waitFor(() => expect(pushSwitch()).toBeChecked());
    expect(pushSwitch()).not.toHaveAttribute('aria-busy');
    expect(onToast).toHaveBeenCalledTimes(1);
  });
});
