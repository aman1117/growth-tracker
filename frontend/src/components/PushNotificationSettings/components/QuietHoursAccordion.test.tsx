import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { pushPreferences } from '../../../test/fixtures/settings';
import { QuietHoursAccordion } from './QuietHoursAccordion';

type Props = ComponentProps<typeof QuietHoursAccordion>;

const quietOn = pushPreferences({
  quiet_hours_enabled: true,
  quiet_start: '22:00',
  quiet_end: '07:00',
});

function renderAccordion(props: Partial<Props> = {}) {
  const handlers = {
    onToggleExpand: vi.fn(),
    onQuietHoursToggle: vi.fn(),
    onQuietTimeChange: vi.fn(),
  };
  render(
    <QuietHoursAccordion
      isExpanded
      preferences={pushPreferences()}
      localQuietStart="22:00"
      localQuietEnd="07:00"
      isLoading={false}
      {...handlers}
      {...props}
    />
  );
  return { user: userEvent.setup(), ...handlers };
}

const header = () => screen.getByRole('button', { name: /^Quiet hours/ });

describe('QuietHoursAccordion', () => {
  it('summarises quiet hours as off in the collapsed header', async () => {
    const { user, onToggleExpand } = renderAccordion({ isExpanded: false, preferences: null });

    expect(header()).toHaveAttribute('aria-expanded', 'false');
    expect(header()).toHaveTextContent('Off');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();

    await user.click(header());
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('shows the active window in the header', () => {
    renderAccordion({ isExpanded: false, preferences: quietOn });

    expect(header()).toHaveTextContent('22:00 – 07:00');
  });

  it('offers a switch, and no times, while quiet hours are off', async () => {
    const { user, onQuietHoursToggle } = renderAccordion();

    const panel = document.getElementById(header().getAttribute('aria-controls')!)!;
    const toggle = within(panel).getByRole('switch', { name: 'Pause notifications' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription('Hold them during the hours you pick');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(onQuietHoursToggle).toHaveBeenCalledWith(true);
  });

  it('lets the user pick start and end hours once enabled', async () => {
    const { user, onQuietHoursToggle, onQuietTimeChange } = renderAccordion({
      preferences: quietOn,
    });

    const from = screen.getByRole('combobox', { name: 'From' });
    const to = screen.getByRole('combobox', { name: 'To' });
    expect(from).toHaveValue('22:00');
    expect(to).toHaveValue('07:00');
    const hours = within(from).getAllByRole('option');
    expect(hours).toHaveLength(24);
    expect(hours[0]).toHaveTextContent('00:00');
    expect(hours[23]).toHaveTextContent('23:00');

    await user.selectOptions(from, '21:00');
    expect(onQuietTimeChange).toHaveBeenLastCalledWith('start', '21:00');
    await user.selectOptions(to, '06:00');
    expect(onQuietTimeChange).toHaveBeenLastCalledWith('end', '06:00');

    await user.click(screen.getByRole('switch', { name: 'Pause notifications' }));
    expect(onQuietHoursToggle).toHaveBeenCalledWith(false);
  });

  it('ignores the switch while saving', async () => {
    const { user, onQuietHoursToggle } = renderAccordion({ isLoading: true });

    await user.click(screen.getByRole('switch', { name: 'Pause notifications' }));

    expect(onQuietHoursToggle).not.toHaveBeenCalled();
  });
});
