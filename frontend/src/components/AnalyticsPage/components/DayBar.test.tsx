import { render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';

import { dayAnalytics } from '../../../test/fixtures/settings';
import { DayBar } from './DayBar';
import styles from './DayBar.module.css';

// 6h in total: three named activities plus two small ones that roll up into "Others"
const monday = dayAnalytics('2025-03-10', 'Monday', {
  sleep: 3,
  study: 1.5,
  workout: 1,
  reels: 0.25,
  eating: 0.25,
});

function renderBar(props: Partial<ComponentProps<typeof DayBar>> = {}) {
  return render(<DayBar day={monday} animate delay={0} {...props} />);
}

/** The bar's track; its title states the day's visible hours */
const track = (title = 'Monday: 6.0h') => screen.getByTitle(title);
const stack = (title?: string) => track(title).firstElementChild as HTMLElement;
const segmentTitles = (title?: string) =>
  Array.from(stack(title).children).map((segment) => segment.getAttribute('title'));

describe('DayBar', () => {
  it('labels the day briefly for sighted users and in full for screen readers', () => {
    renderBar();

    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('6.0h')).toBeInTheDocument();
    expect(screen.getByText('Monday: 6.0 hours')).toBeInTheDocument();
  });

  it('marks today', () => {
    const { container } = renderBar({ isToday: true });

    expect(screen.getByText('Monday (today): 6.0 hours')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass(styles.today);
  });

  it('shows a dash and an empty track for a day with nothing logged', () => {
    renderBar({ day: dayAnalytics('2025-03-11', 'Tuesday') });

    expect(screen.getByText('Tue')).toBeInTheDocument();
    expect(screen.getByText('–')).toBeInTheDocument();
    expect(screen.getByText('Tuesday: nothing logged')).toBeInTheDocument();
    expect(stack('Tuesday: 0.0h')).toHaveClass(styles.empty);
  });

  it.each([
    [undefined, '25%'],
    [24, '25%'],
    [8, '75%'],
    [6, '100%'],
    [4, '100%'],
    [0, '25%'],
  ])('scales 6 hours against a chart maximum of %s hours to %s', (scaleMax, height) => {
    renderBar({ scaleMax });

    expect(stack()).toHaveStyle({ height });
  });

  it('grows the bar only once it is animated in', () => {
    renderBar({ animate: false, scaleMax: 6 });

    expect(stack()).toHaveStyle({ height: '0%' });
  });

  it('stacks the top three activities above an "Others" segment for the rest', () => {
    renderBar();

    expect(segmentTitles()).toEqual([
      'Others: 0.5h',
      'Workout: 1.0h',
      'Study: 1.5h',
      'Sleep: 3.0h',
    ]);
    expect(within(stack()).getByTitle('Sleep: 3.0h')).toHaveStyle({
      flexGrow: '3',
      background: '#6366f1',
    });
  });

  it('shows only the filtered activities', () => {
    renderBar({ activityFilter: ['study', 'workout'], scaleMax: 5 });

    expect(screen.getByText('2.5h')).toBeInTheDocument();
    expect(screen.getByText('Monday: 2.5 hours')).toBeInTheDocument();
    expect(segmentTitles('Monday: 2.5h')).toEqual(['Workout: 1.0h', 'Study: 1.5h']);
    expect(stack('Monday: 2.5h')).toHaveStyle({ height: '50%' });
  });

  it('draws a single filtered activity as one segment in its own color', () => {
    renderBar({ activityFilter: ['sleep'], tileColors: { sleep: '#123456' } });

    expect(segmentTitles('Monday: 3.0h')).toEqual(['Sleep: 3.0h']);
    expect(within(stack('Monday: 3.0h')).getByTitle('Sleep: 3.0h')).toHaveStyle({
      background: '#123456',
    });
  });

  it('treats a day without the filtered activity as empty', () => {
    renderBar({ activityFilter: ['family'] });

    expect(screen.getByText('Monday: nothing logged')).toBeInTheDocument();
    expect(stack('Monday: 0.0h')).toHaveClass(styles.empty);
  });

  it('names and colors custom tiles, falling back to a neutral color', () => {
    const day = dayAnalytics('2025-03-12', 'Wednesday', { 'custom:g1': 2, 'custom:x9': 1 });
    const customTiles = [
      { id: 'g1', name: 'Guitar', icon: 'Music', color: '#ff00aa' },
      { id: 'x9', name: 'Chess', icon: 'Crown', color: '' },
    ];

    const { rerender } = renderBar({ day, customTiles });
    const bar = stack('Wednesday: 3.0h');
    expect(within(bar).getByTitle('Guitar: 2.0h')).toHaveStyle({ background: '#ff00aa' });
    expect(within(bar).getByTitle('Chess: 1.0h')).toHaveStyle({ background: '#64748b' });

    rerender(
      <DayBar
        day={day}
        animate
        delay={0}
        customTiles={customTiles}
        activityFilter={['custom:x9']}
      />
    );
    expect(within(stack('Wednesday: 1.0h')).getByTitle('Chess: 1.0h')).toHaveStyle({
      background: '#64748b',
    });
  });
});
