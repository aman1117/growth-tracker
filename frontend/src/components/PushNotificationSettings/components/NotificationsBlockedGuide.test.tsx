import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ANDROID_CHROME_UA,
  DESKTOP_CHROME_UA,
  IPHONE_SAFARI_UA,
  stubInstalledApp,
  stubUserAgent,
} from '../../../test/fixtures/settings';
import { NotificationsBlockedGuide } from './NotificationsBlockedGuide';

function renderGuide(isOpen = true) {
  const onClose = vi.fn();
  render(<NotificationsBlockedGuide isOpen={isOpen} onClose={onClose} />);
  return { user: userEvent.setup(), onClose };
}

describe('NotificationsBlockedGuide', () => {
  beforeEach(() => {
    stubUserAgent(DESKTOP_CHROME_UA);
    // Modal logs overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('renders nothing while closed', () => {
    renderGuide(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists numbered steps for a desktop browser', () => {
    renderGuide();

    const dialog = screen.getByRole('dialog', { name: 'Turn on notifications' });
    expect(within(dialog).getByText('It only takes a few taps')).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((step) => step.textContent)
    ).toEqual([
      '1Click the site settings icon next to the address bar',
      '2Find “Notifications”',
      '3Change it from “Block” to “Allow”',
      '4Refresh the page',
    ]);
  });

  it('shows the steps for the current platform', () => {
    stubUserAgent(ANDROID_CHROME_UA, 5);
    stubInstalledApp();
    renderGuide();

    expect(screen.getByRole('dialog', { name: 'Turn on in app settings' })).toBeInTheDocument();
  });

  it('shows the iOS install steps in Safari', () => {
    stubUserAgent(IPHONE_SAFARI_UA, 5);
    renderGuide();

    expect(
      screen.getByRole('dialog', { name: 'Turn on notifications on iOS' })
    ).toBeInTheDocument();
  });

  it.each(['Got it', 'Close'])('closes with "%s"', async (name) => {
    const { user, onClose } = renderGuide();

    await user.click(screen.getByRole('button', { name }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
