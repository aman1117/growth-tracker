import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SettingsSection } from './SettingsSection';

describe('SettingsSection', () => {
  it('is a region named by its visible title', () => {
    render(
      <SettingsSection title="Account">
        <button type="button">Username</button>
      </SettingsSection>
    );

    const section = screen.getByRole('region', { name: 'Account' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Account' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Username' })).toBeInTheDocument();
  });

  it('uses the aria label when it has no visible title', () => {
    render(
      <SettingsSection ariaLabel="Session" className="extra">
        <button type="button">Log out</button>
      </SettingsSection>
    );

    const section = screen.getByRole('region', { name: 'Session' });
    expect(section).toHaveClass('extra');
    expect(within(section).queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows an optional footnote under the group', () => {
    render(
      <SettingsSection title="Notifications" footnote="Only on this device">
        <p>Rows</p>
      </SettingsSection>
    );

    expect(screen.getByText('Only on this device')).toBeInTheDocument();
  });
});
