import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { pushPreferences } from '../../../test/fixtures/settings';
import { NotificationTypesAccordion } from './NotificationTypesAccordion';

type Props = ComponentProps<typeof NotificationTypesAccordion>;

function renderAccordion(props: Partial<Props> = {}) {
  const onToggleExpand = vi.fn();
  const onTypeToggle = vi.fn();
  render(
    <NotificationTypesAccordion
      isExpanded
      onToggleExpand={onToggleExpand}
      preferences={pushPreferences()}
      isLoading={false}
      onTypeToggle={onTypeToggle}
      {...props}
    />
  );
  return { user: userEvent.setup(), onToggleExpand, onTypeToggle };
}

const header = () => screen.getByRole('button', { name: /^Notification types/ });

describe('NotificationTypesAccordion', () => {
  it('collapses to a header that summarises how many types are on', async () => {
    const { user, onToggleExpand } = renderAccordion({
      isExpanded: false,
      preferences: pushPreferences({ preferences: { streak_at_risk: false } }),
    });

    expect(header()).toHaveAttribute('aria-expanded', 'false');
    expect(header()).toHaveTextContent('3 of 4 on');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();

    await user.click(header());
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('treats every type as on until preferences have loaded', () => {
    renderAccordion({ preferences: null });

    expect(header()).toHaveTextContent('4 of 4 on');
    screen.getAllByRole('switch').forEach((toggle) => expect(toggle).toBeChecked());
  });

  it('lists a labelled, described switch per type inside the panel it controls', () => {
    renderAccordion({ preferences: pushPreferences({ preferences: { like_received: false } }) });

    expect(header()).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(header().getAttribute('aria-controls')!)!;
    const switches = within(panel).getAllByRole('switch');
    expect(switches.map((toggle) => toggle.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'true',
      'true',
    ]);

    const likes = within(panel).getByRole('switch', { name: 'Likes' });
    expect(likes).toHaveAccessibleDescription('When someone likes your day');
    expect(
      within(panel).getByRole('switch', { name: 'Streak reminders' })
    ).toHaveAccessibleDescription('When your streak is at risk');
  });

  it('asks to flip a type when its switch or label is used', async () => {
    const { user, onTypeToggle } = renderAccordion({
      preferences: pushPreferences({ preferences: { like_received: false } }),
    });

    await user.click(screen.getByRole('switch', { name: 'Likes' }));
    expect(onTypeToggle).toHaveBeenLastCalledWith('like_received', true);

    await user.click(screen.getByText('Badges'));
    expect(onTypeToggle).toHaveBeenLastCalledWith('badge_unlocked', false);
  });

  it('ignores input but keeps the switches focusable while saving', async () => {
    const { user, onTypeToggle } = renderAccordion({ isLoading: true });

    const likes = screen.getByRole('switch', { name: 'Likes' });
    await user.click(likes);

    expect(likes).toHaveFocus();
    expect(likes).toHaveAttribute('aria-busy', 'true');
    expect(onTypeToggle).not.toHaveBeenCalled();
  });
});
