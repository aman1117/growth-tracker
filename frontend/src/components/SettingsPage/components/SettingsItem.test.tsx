import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Lock } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import type { SettingsItemProps } from '../SettingsPage.types';
import { SettingsItem } from './SettingsItem';
import styles from './SettingsItem.module.css';

function renderItem(props: Partial<SettingsItemProps> = {}) {
  return render(<SettingsItem icon={<Lock data-testid="icon" />} label="Username" {...props} />);
}

const chevron = (container: HTMLElement) => container.querySelector('.lucide-chevron-right');

describe('SettingsItem', () => {
  it('renders a button row with a chevron when it has an action', async () => {
    const onClick = vi.fn();
    const { container } = renderItem({ value: '@alice', onClick });

    const row = screen.getByRole('button', { name: /^Username\s*@alice$/ });
    expect(chevron(container)).toBeInTheDocument();

    await userEvent.setup().click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders an external link that opens in a new tab', () => {
    const { container } = renderItem({
      label: 'FAQs & help',
      value: 'Answers to common questions',
      href: 'https://help.example',
      external: true,
    });

    const link = screen.getByRole('link', {
      name: /^FAQs & help\s*\(opens in a new tab\)\s*Answers to common questions$/,
    });
    expect(link).toHaveAttribute('href', 'https://help.example');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelector('.lucide-external-link')).toBeInTheDocument();
    expect(chevron(container)).not.toBeInTheDocument();
  });

  it('renders an in-app link without opening a new tab', () => {
    renderItem({ href: '/settings/blocked' });

    const link = screen.getByRole('link', { name: 'Username' });
    expect(link).not.toHaveAttribute('target');
    expect(link).not.toHaveAttribute('rel');
  });

  it('renders a static row without a chevron', () => {
    const { container } = renderItem({ label: 'Theme', value: 'Follows your device setting' });

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Follows your device setting')).toBeInTheDocument();
    expect(chevron(container)).not.toBeInTheDocument();
  });

  it('names and describes its trailing control and makes the row text its label', async () => {
    const onToggle = vi.fn();
    renderItem({
      label: 'Private account',
      value: 'Anyone can see your days',
      controlId: 'privacy',
      trailing: (
        <button
          id="privacy"
          type="button"
          role="switch"
          aria-checked="false"
          aria-labelledby="privacy-label"
          aria-describedby="privacy-description"
          onClick={onToggle}
        />
      ),
    });

    const control = screen.getByRole('switch', { name: 'Private account' });
    expect(control).toHaveAccessibleDescription('Anyone can see your days');

    await userEvent.setup().click(screen.getByText('Private account'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does not point to a missing description when there is no value', () => {
    renderItem({
      label: 'Private account',
      controlId: 'privacy',
      trailing: <button id="privacy" type="button" aria-labelledby="privacy-label" />,
    });

    expect(screen.getByText('Private account')).toHaveAttribute('id', 'privacy-label');
    expect(document.getElementById('privacy-description')).toBeNull();
  });

  it.each([
    [5, '5'],
    [99, '99'],
    [120, '99+'],
  ])('shows a count badge of %i as %s', (badge, text) => {
    renderItem({ onClick: vi.fn(), badge });

    expect(screen.getByRole('button')).toHaveTextContent(`Username${text}`);
  });

  it('hides a zero count', () => {
    renderItem({ onClick: vi.fn(), badge: 0 });

    expect(screen.getByRole('button')).toHaveTextContent(/^Username$/);
  });

  it('styles destructive rows in red without a chevron', () => {
    const { container } = renderItem({
      label: 'Log out',
      danger: true,
      tone: 'sky',
      onClick: vi.fn(),
    });

    const row = screen.getByRole('button', { name: 'Log out' });
    expect(row).toHaveClass(styles.danger);
    expect(screen.getByTestId('icon').parentElement).toHaveClass(styles.toneRed);
    expect(chevron(container)).not.toBeInTheDocument();
  });

  it('tints the icon chip by tone, or with explicit colors', () => {
    const { rerender } = renderItem({ tone: 'teal' });
    expect(screen.getByTestId('icon').parentElement).toHaveClass(styles.toneTeal);

    rerender(
      <SettingsItem
        icon={<Lock data-testid="icon" />}
        label="Custom"
        iconColor="rgb(1, 2, 3)"
        iconBg="rgb(4, 5, 6)"
      />
    );
    expect(screen.getByTestId('icon').parentElement).toHaveStyle({
      color: 'rgb(1, 2, 3)',
      background: 'rgb(4, 5, 6)',
    });
  });

  it('replaces the chevron with a custom trailing element', () => {
    const { container } = renderItem({ onClick: vi.fn(), trailing: <span>Beta</span> });

    expect(screen.getByRole('button', { name: /^Username\s*Beta$/ })).toBeInTheDocument();
    expect(chevron(container)).not.toBeInTheDocument();
  });

  it('renders extra content under the row in the same group', () => {
    renderItem({ onClick: vi.fn(), children: <p>Expanded preferences</p> });

    const row = screen.getByRole('button', { name: 'Username' });
    const extra = screen.getByText('Expanded preferences');
    expect(row).not.toContainElement(extra);
    expect(row.parentElement).toContainElement(extra);
  });
});
