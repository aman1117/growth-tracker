import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_CHROME_UA,
  IPHONE_SAFARI_UA,
  stubUserAgent,
} from '../../../test/fixtures/settings';
import { NotificationsBlockedDialog } from './NotificationsBlockedDialog';

describe('NotificationsBlockedDialog', () => {
  beforeEach(() => {
    // Modal logs overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('renders nothing while closed', () => {
    render(<NotificationsBlockedDialog isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the browser steps on desktop and closes with "Got it"', async () => {
    stubUserAgent(DESKTOP_CHROME_UA);
    const onClose = vi.fn();
    render(<NotificationsBlockedDialog isOpen onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: 'Turn on notifications' });
    expect(within(dialog).getAllByRole('listitem')[0]).toHaveTextContent(
      'Click the site settings icon next to the address bar'
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'Got it' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses the same platform guide as push settings (iOS Safari)', () => {
    stubUserAgent(IPHONE_SAFARI_UA, 5);
    render(<NotificationsBlockedDialog isOpen onClose={vi.fn()} />);

    expect(
      screen.getByRole('dialog', { name: 'Turn on notifications on iOS' })
    ).toBeInTheDocument();
  });
});
