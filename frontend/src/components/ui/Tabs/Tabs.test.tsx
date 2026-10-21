import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { type Tab, Tabs } from './Tabs';
import styles from './Tabs.module.css';

const TABS: Tab[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month', icon: <svg data-icon="calendar" /> },
  { id: 'year', label: 'Year', disabled: true },
];

describe('Tabs', () => {
  it('renders a tablist with the active tab selected', () => {
    render(<Tabs tabs={TABS} activeTab="month" onTabChange={vi.fn()} />);

    expect(screen.getByRole('tablist')).toHaveClass(styles.tabs, styles.md, styles.default);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Week',
      'Month',
      'Year',
    ]);
    expect(screen.getByRole('tab', { name: 'Month' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Month' })).toHaveClass(styles.active);
    expect(screen.getByRole('tab', { name: 'Week' })).toHaveAttribute('aria-selected', 'false');
  });

  it('renders tab icons', () => {
    render(<Tabs tabs={TABS} activeTab="week" onTabChange={vi.fn()} />);
    const icon = screen.getByRole('tab', { name: 'Month' }).querySelector('[data-icon]');

    expect(icon?.parentElement).toHaveClass(styles.icon);
  });

  it('calls onTabChange with the clicked tab id', async () => {
    const onTabChange = vi.fn();
    render(<Tabs tabs={TABS} activeTab="week" onTabChange={onTabChange} />);

    await userEvent.click(screen.getByRole('tab', { name: 'Month' }));
    expect(onTabChange).toHaveBeenCalledExactlyOnceWith('month');
  });

  it('disables tabs that cannot be selected', async () => {
    const onTabChange = vi.fn();
    render(<Tabs tabs={TABS} activeTab="week" onTabChange={onTabChange} />);
    const year = screen.getByRole('tab', { name: 'Year' });

    expect(year).toBeDisabled();
    expect(year).toHaveAttribute('aria-disabled', 'true');
    expect(year).toHaveClass(styles.disabled);
    await userEvent.click(year);
    expect(onTabChange).not.toHaveBeenCalled();
  });

  describe('keyboard', () => {
    const PERIODS: Tab[] = [
      { id: 'day', label: 'Day' },
      { id: 'week', label: 'Week', disabled: true },
      { id: 'month', label: 'Month' },
      { id: 'year', label: 'Year' },
    ];
    const tab = (name: string) => screen.getByRole('tab', { name });

    it('is a single Tab stop that lands on the selected tab', async () => {
      const user = userEvent.setup();
      render(
        <>
          <Tabs tabs={PERIODS} activeTab="month" onTabChange={vi.fn()} />
          <button type="button">After</button>
        </>
      );

      expect(tab('Month')).toHaveAttribute('tabindex', '0');
      expect(tab('Day')).toHaveAttribute('tabindex', '-1');
      expect(tab('Year')).toHaveAttribute('tabindex', '-1');

      await user.tab();
      expect(tab('Month')).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
      await user.tab({ shift: true });
      expect(tab('Month')).toHaveFocus();
    });

    it('moves focus with the arrow keys, wrapping and skipping disabled tabs', async () => {
      const user = userEvent.setup();
      const onTabChange = vi.fn();
      render(<Tabs tabs={PERIODS} activeTab="day" onTabChange={onTabChange} />);

      await user.tab();
      await user.keyboard('{ArrowRight}');
      expect(tab('Month')).toHaveFocus();
      await user.keyboard('{ArrowRight}');
      expect(tab('Year')).toHaveFocus();
      await user.keyboard('{ArrowRight}');
      expect(tab('Day')).toHaveFocus();
      await user.keyboard('{ArrowLeft}');
      expect(tab('Year')).toHaveFocus();
      await user.keyboard('{ArrowLeft}{ArrowLeft}');
      expect(tab('Day')).toHaveFocus();

      // Moving focus does not change the selection (manual activation)
      expect(onTabChange).not.toHaveBeenCalled();
      expect(tab('Day')).toHaveAttribute('aria-selected', 'true');
    });

    it('jumps to the first and last enabled tabs with Home and End', async () => {
      const user = userEvent.setup();
      const tabs: Tab[] = [
        { id: 'a', label: 'A', disabled: true },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D', disabled: true },
      ];
      render(<Tabs tabs={tabs} activeTab="c" onTabChange={vi.fn()} />);

      await user.tab();
      await user.keyboard('{Home}');
      expect(tab('B')).toHaveFocus();
      await user.keyboard('{End}');
      expect(tab('C')).toHaveFocus();
    });

    it('selects the focused tab with Enter or Space', async () => {
      const user = userEvent.setup();
      const onTabChange = vi.fn();
      render(<Tabs tabs={PERIODS} activeTab="day" onTabChange={onTabChange} />);

      await user.tab();
      await user.keyboard('{ArrowRight}{Enter}');
      expect(onTabChange).toHaveBeenLastCalledWith('month');
      await user.keyboard('{ArrowRight} ');
      expect(onTabChange).toHaveBeenLastCalledWith('year');
      expect(onTabChange).toHaveBeenCalledTimes(2);
    });

    it('only claims the keys it handles, leaving browser shortcuts alone', () => {
      render(<Tabs tabs={PERIODS} activeTab="day" onTabChange={vi.fn()} />);
      act(() => tab('Day').focus());

      expect(fireEvent.keyDown(tab('Day'), { key: 'End' })).toBe(false);
      expect(tab('Year')).toHaveFocus();
      expect(fireEvent.keyDown(tab('Year'), { key: 'ArrowDown' })).toBe(true);
      expect(fireEvent.keyDown(tab('Year'), { key: 'ArrowLeft', altKey: true })).toBe(true);
      expect(fireEvent.keyDown(tab('Year'), { key: 'Home', ctrlKey: true })).toBe(true);
      expect(fireEvent.keyDown(tab('Year'), { key: 'ArrowRight', metaKey: true })).toBe(true);
      expect(tab('Year')).toHaveFocus();
    });

    it('falls back to the first enabled tab as the Tab stop when the selection is unusable', () => {
      const { rerender } = render(
        <Tabs tabs={PERIODS} activeTab="missing" onTabChange={vi.fn()} />
      );
      expect(tab('Day')).toHaveAttribute('tabindex', '0');

      rerender(<Tabs tabs={PERIODS} activeTab="week" onTabChange={vi.fn()} />);
      expect(tab('Day')).toHaveAttribute('tabindex', '0');
      expect(tab('Week')).toHaveAttribute('tabindex', '-1');
    });

    it('ignores navigation keys when every tab is disabled', () => {
      const tabs: Tab[] = [
        { id: 'a', label: 'A', disabled: true },
        { id: 'b', label: 'B', disabled: true },
      ];
      render(<Tabs tabs={tabs} activeTab="a" onTabChange={vi.fn()} />);

      expect(fireEvent.keyDown(tab('A'), { key: 'ArrowRight' })).toBe(true);
    });
  });

  it('supports sizes, variants, full width and custom classes', () => {
    render(
      <Tabs
        tabs={TABS}
        activeTab="week"
        onTabChange={vi.fn()}
        size="lg"
        variant="pills"
        fullWidth
        className="filters"
      />
    );

    expect(screen.getByRole('tablist')).toHaveClass(
      styles.lg,
      styles.pills,
      styles.fullWidth,
      'filters'
    );
    expect(screen.getByRole('tablist').querySelector(`.${styles.indicator}`)).toBeNull();
  });

  it('moves the underline indicator under the active tab', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80);
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.dataset.tabId === 'month' ? 96 : 0;
    });

    const { rerender } = render(
      <Tabs tabs={TABS} activeTab="month" onTabChange={vi.fn()} variant="underline" />
    );
    const indicator = screen
      .getByRole('tablist')
      .querySelector<HTMLElement>(`.${styles.indicator}`);

    expect(indicator).toHaveStyle({ width: '80px', transform: 'translateX(96px)' });

    rerender(<Tabs tabs={TABS} activeTab="week" onTabChange={vi.fn()} variant="underline" />);
    expect(indicator).toHaveStyle({ transform: 'translateX(0px)' });
  });

  it('leaves the indicator in place when the active id matches no tab', () => {
    render(<Tabs tabs={TABS} activeTab="missing" onTabChange={vi.fn()} variant="underline" />);
    const indicator = screen
      .getByRole('tablist')
      .querySelector<HTMLElement>(`.${styles.indicator}`);

    expect(indicator?.getAttribute('style') ?? '').toBe('');
    screen.getAllByRole('tab').forEach((tab) => {
      expect(tab).toHaveAttribute('aria-selected', 'false');
    });
  });
});
