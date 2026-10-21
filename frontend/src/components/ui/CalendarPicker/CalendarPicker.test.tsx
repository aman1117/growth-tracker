import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarPicker, type CalendarPickerProps } from './CalendarPicker';
import styles from './CalendarPicker.module.css';

// "Today" is Wednesday, October 21, 2026; October 2026 starts on a Thursday.
const TODAY = new Date(2026, 9, 21, 10, 30);

const longDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

/** Day cell whose accessible name starts with the full date, e.g. "Monday, October 5, 2026". */
const getDay = (year: number, month: number, day: number) => {
  const prefix = longDate.format(new Date(year, month, day));
  return screen.getByRole('button', { name: (name) => name.startsWith(prefix) });
};

const DAY_NAME = /^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, /;

function renderPicker(props: Partial<CalendarPickerProps> = {}) {
  const onClose = vi.fn();
  const onDateSelect = vi.fn();
  const selectedDate = props.selectedDate ?? new Date(2026, 9, 21);
  const utils = render(
    <CalendarPicker
      isOpen
      onClose={onClose}
      onDateSelect={onDateSelect}
      {...props}
      selectedDate={selectedDate}
    />
  );
  return { onClose, onDateSelect, selectedDate, ...utils };
}

/** Lets the picker attach its deferred outside-click listeners. */
const waitForOutsideListeners = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

describe('CalendarPicker', () => {
  beforeEach(() => {
    vi.setSystemTime(TODAY);
  });

  it('renders nothing while closed', () => {
    renderPicker({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the selected month in a labelled dialog rendered in a portal', () => {
    const { container } = renderPicker();
    const dialog = screen.getByRole('dialog', { name: 'Choose a date' });

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(container).not.toContainElement(dialog);
    expect(within(dialog).getByRole('button', { name: 'October, choose month' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '2026, choose year' })).toBeVisible();

    // Six full weeks, padded with the neighbouring months
    const days = within(dialog).getAllByRole('button', { name: DAY_NAME });
    expect(days).toHaveLength(42);
    expect(days[0]).toHaveAccessibleName('Sunday, September 27, 2026');
    expect(days[0]).toHaveClass(styles.outside);
    expect(days[4]).toHaveAccessibleName('Thursday, October 1, 2026');
    expect(days[4]).not.toHaveClass(styles.outside);
    expect(days[41]).toHaveAccessibleName('Saturday, November 7, 2026');
  });

  it('marks today and the selected day', () => {
    renderPicker({ selectedDate: new Date(2026, 9, 5) });
    const today = getDay(2026, 9, 21);
    const selected = getDay(2026, 9, 5);

    expect(today).toHaveAccessibleName('Wednesday, October 21, 2026, today');
    expect(today).toHaveAttribute('aria-current', 'date');
    expect(today).toHaveClass(styles.today);
    expect(selected).toHaveAccessibleName('Monday, October 5, 2026, selected');
    expect(selected).toHaveClass(styles.selected);
    expect(selected).not.toHaveAttribute('aria-current');
  });

  it('disables days after the max date, which defaults to today', () => {
    renderPicker();

    expect(getDay(2026, 9, 21)).toBeEnabled();
    expect(getDay(2026, 9, 22)).toBeDisabled();
    expect(getDay(2026, 10, 1)).toBeDisabled();
    expect(getDay(2026, 8, 27)).toBeEnabled();
  });

  it('selects a day and closes after the exit animation', async () => {
    const { onDateSelect, onClose } = renderPicker();

    await userEvent.click(getDay(2026, 9, 5));

    expect(onDateSelect).toHaveBeenCalledExactlyOnceWith(new Date(2026, 9, 5));
    expect(screen.getByRole('dialog')).toHaveClass(styles.closing);
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('lets keyboard users move between days and pick one', async () => {
    const user = userEvent.setup();
    const { onDateSelect } = renderPicker();

    getDay(2026, 9, 12).focus();
    await user.tab();
    expect(getDay(2026, 9, 13)).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onDateSelect).toHaveBeenCalledExactlyOnceWith(new Date(2026, 9, 13));
  });

  it('pages through months but never past the max month', async () => {
    const user = userEvent.setup();
    const onMonthChange = vi.fn();
    renderPicker({ onMonthChange });
    const next = screen.getByRole('button', { name: 'Next month' });

    expect(onMonthChange).toHaveBeenLastCalledWith(2026, 9);
    expect(next).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('button', { name: 'September, choose month' })).toBeInTheDocument();
    expect(onMonthChange).toHaveBeenLastCalledWith(2026, 8);
    expect(next).toBeEnabled();

    await user.click(next);
    expect(screen.getByRole('button', { name: 'October, choose month' })).toBeInTheDocument();
    expect(onMonthChange).toHaveBeenLastCalledWith(2026, 9);
    expect(next).toBeDisabled();
  });

  it('crosses into the previous year', async () => {
    renderPicker({ selectedDate: new Date(2026, 0, 15) });

    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));

    expect(screen.getByRole('button', { name: 'December, choose month' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2025, choose year' })).toBeInTheDocument();
  });

  it('allows future dates up to a custom max date', async () => {
    const user = userEvent.setup();
    renderPicker({ maxDate: new Date(2026, 11, 31) });
    const next = screen.getByRole('button', { name: 'Next month' });

    expect(getDay(2026, 9, 22)).toBeEnabled();
    await user.click(next);
    await user.click(next);
    expect(screen.getByRole('button', { name: 'December, choose month' })).toBeInTheDocument();
    expect(next).toBeDisabled();
  });

  it('picks a month from the month view, with months after the max date disabled', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: 'October, choose month' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryAllByRole('button', { name: DAY_NAME })).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Oct' })).toHaveClass(styles.selected);
    expect(within(dialog).getByRole('button', { name: 'Nov' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Dec' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Next month' })).toBeDisabled();
    // The left header button now opens the year view
    expect(within(dialog).getByRole('button', { name: 'Choose year' })).toBeEnabled();

    await user.click(within(dialog).getByRole('button', { name: 'Mar' }));
    expect(screen.getByRole('button', { name: 'March, choose month' })).toBeInTheDocument();
    expect(getDay(2026, 2, 1)).toBeEnabled();
  });

  it('picks a year from the year view, then a month', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: '2026, choose year' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Select Year')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Choose year' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Next month' })).toBeDisabled();
    const years = within(dialog).getAllByRole('button', { name: /^20\d\d$/ });
    expect(years.map((year) => year.textContent)).toEqual([
      '2026',
      '2025',
      '2024',
      '2023',
      '2022',
      '2021',
      '2020',
    ]);
    expect(within(dialog).getByRole('button', { name: '2026' })).toHaveClass(styles.selected);

    await user.click(within(dialog).getByRole('button', { name: '2024' }));
    expect(within(dialog).getByRole('button', { name: '2024, choose year' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Dec' })).toBeEnabled();

    await user.click(within(dialog).getByRole('button', { name: 'Feb' }));
    expect(getDay(2024, 1, 29)).toBeEnabled();
  });

  it('opens the year view from the month view', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: 'October, choose month' }));
    await user.click(screen.getByRole('button', { name: 'Choose year' }));
    expect(screen.getByText('Select Year')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '2025' }));
    await user.click(screen.getByRole('button', { name: '2025, choose year' }));
    expect(screen.getByText('Select Year')).toBeInTheDocument();
  });

  it('shows the heat map of logged hours with a legend', async () => {
    renderPicker({
      completionData: {
        '2026-10-01': 3,
        '2026-10-02': 6,
        '2026-10-03': 12,
        '2026-10-04': 18,
        '2026-10-05': 24,
        '2026-10-06': 0,
      },
    });

    expect(getDay(2026, 9, 1)).toHaveClass(styles.heatLevel1);
    expect(getDay(2026, 9, 1)).toHaveAttribute('title', '3/24 hours logged');
    expect(getDay(2026, 9, 1)).toHaveAccessibleName('Thursday, October 1, 2026, 3/24 hours logged');
    expect(getDay(2026, 9, 2)).toHaveClass(styles.heatLevel2);
    expect(getDay(2026, 9, 3)).toHaveClass(styles.heatLevel3);
    expect(getDay(2026, 9, 4)).toHaveClass(styles.heatLevel4);
    expect(getDay(2026, 9, 5)).toHaveClass(styles.heatComplete);
    expect(getDay(2026, 9, 5)).toHaveAttribute('title', '24/24 hours - Day complete! ✓');
    expect(getDay(2026, 9, 6)).not.toHaveAttribute('title');
    expect(getDay(2026, 9, 6).className).not.toMatch(/heat/);

    const legend = screen.getByText('Less').parentElement;
    expect(legend).toHaveAttribute('aria-hidden', 'true');
    expect(within(legend as HTMLElement).getByText('More')).toBeInTheDocument();

    // The legend belongs to the day grid only
    await userEvent.click(screen.getByRole('button', { name: 'October, choose month' }));
    expect(screen.queryByText('Less')).not.toBeInTheDocument();
  });

  it('has no heat map or legend without completion data', () => {
    renderPicker();

    expect(getDay(2026, 9, 1)).not.toHaveAttribute('title');
    expect(screen.queryByText('Less')).not.toBeInTheDocument();
  });

  it('jumps to today', async () => {
    const { onDateSelect, onClose } = renderPicker({ selectedDate: new Date(2026, 2, 3) });

    await userEvent.click(screen.getByRole('button', { name: 'Today' }));

    expect(onDateSelect).toHaveBeenCalledTimes(1);
    expect((onDateSelect.mock.calls[0][0] as Date).toDateString()).toBe(TODAY.toDateString());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('closes on Escape', async () => {
    const { onClose } = renderPicker();

    await userEvent.keyboard('{Escape}');

    expect(screen.getByRole('dialog').parentElement).toHaveClass(styles.closing);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('ignores other keys', async () => {
    const { onClose } = renderPicker();

    await userEvent.keyboard('{Enter}a');
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a click or touch outside the calendar, but not inside it', async () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Outside</button>
        <CalendarPicker
          isOpen
          onClose={onClose}
          selectedDate={new Date(2026, 9, 21)}
          onDateSelect={vi.fn()}
        />
      </>
    );
    await waitForOutsideListeners();

    fireEvent.mouseDown(screen.getByText('Su'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    fireEvent.touchStart(screen.getByRole('button', { name: 'Outside' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it('closes when the dimmed overlay is clicked', async () => {
    const { onClose } = renderPicker();

    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('closes once when the dimmed overlay gets a real pointer click', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPicker();
    await waitForOutsideListeners();

    await user.click(screen.getByRole('dialog').parentElement as HTMLElement);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores further close requests while the closing animation runs', async () => {
    const { onClose } = renderPicker();
    await waitForOutsideListeners();
    const overlay = screen.getByRole('dialog').parentElement as HTMLElement;

    // A tap fires touchstart, then the compatibility mousedown and click
    fireEvent.touchStart(overlay);
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resets to the selected month and the day view when reopened', async () => {
    const user = userEvent.setup();
    const { rerender, onClose, onDateSelect, selectedDate } = renderPicker();
    const picker = (isOpen: boolean) => (
      <CalendarPicker
        isOpen={isOpen}
        onClose={onClose}
        selectedDate={selectedDate}
        onDateSelect={onDateSelect}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    await user.click(screen.getByRole('button', { name: 'September, choose month' }));
    expect(screen.queryByRole('button', { name: DAY_NAME })).not.toBeInTheDocument();

    rerender(picker(false));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(picker(true));

    expect(screen.getByRole('button', { name: 'October, choose month' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: DAY_NAME })).toHaveLength(42);
  });

  it('closes on the system Back action', async () => {
    const { onClose } = renderPicker();

    await waitFor(() =>
      expect(window.history.state).toEqual(
        expect.objectContaining({ __overlayId: expect.any(String) })
      )
    );
    act(() => window.history.back());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
