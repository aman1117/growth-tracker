import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';

import { ActivityRow } from './ActivityRow';
import styles from './ActivityRow.module.css';

function renderRow(props: Partial<ComponentProps<typeof ActivityRow>> = {}) {
  render(
    <ul>
      <ActivityRow
        activity={{ name: 'sleep', total_hours: 6 }}
        maxHours={8}
        delay={0.03}
        animate
        totalHours={15}
        {...props}
      />
    </ul>
  );
  const row = screen.getByRole('listitem');
  return { row, fill: row.querySelector(`.${styles.fill}`) as HTMLElement };
}

describe('ActivityRow', () => {
  it('shows the activity, its hours and its share of the week', () => {
    const { row } = renderRow();

    expect(row).toHaveTextContent(/^Sleep\s*40%\s*6\.0h$/);
    expect(row.style.getPropertyValue('--row-color')).toBe('#6366f1');
    expect(row.style.getPropertyValue('--delay')).toBe('0.03s');
    expect(row.querySelector('svg')).toBeInTheDocument();
  });

  it.each([undefined, 0])('leaves out the share when the week total is %s', (totalHours) => {
    const { row } = renderRow({ totalHours });

    expect(row).toHaveTextContent(/^Sleep\s*6\.0h$/);
  });

  it('fills the progress bar relative to the top activity once animated', () => {
    expect(renderRow().fill).toHaveStyle({ width: '75%' });
  });

  it('keeps the progress bar empty until it animates in', () => {
    const { row, fill } = renderRow({ animate: false });

    expect(fill).toHaveStyle({ width: '0%' });
    expect(row).toHaveClass(styles.hidden);
  });

  it('keeps the progress bar empty when nothing was logged', () => {
    expect(renderRow({ maxHours: 0 }).fill).toHaveStyle({ width: '0%' });
  });

  it('uses the user’s color for the activity', () => {
    const { row } = renderRow({ tileColors: { sleep: '#000000' } });

    expect(row.style.getPropertyValue('--row-color')).toBe('#000000');
  });

  it('names custom tiles', () => {
    const { row } = renderRow({
      activity: { name: 'custom:g1', total_hours: 2 },
      customTiles: [{ id: 'g1', name: 'Guitar', icon: 'Music', color: '#ff00aa' }],
    });

    expect(row).toHaveTextContent(/^Guitar/);
    expect(row.style.getPropertyValue('--row-color')).toBe('#ff00aa');
  });

  it('falls back to the raw name and a neutral color for an unnamed custom tile', () => {
    const { row } = renderRow({
      activity: { name: 'custom:g1', total_hours: 2 },
      customTiles: [{ id: 'g1', name: '', icon: 'Music', color: '' }],
    });

    expect(row).toHaveTextContent(/^custom:g1/);
    expect(row.style.getPropertyValue('--row-color')).toBe('#64748b');
  });

  it('formats unknown activities and gives them a generic icon', () => {
    const { row } = renderRow({
      activity: { name: 'deep_work' as never, total_hours: 3 },
    });

    expect(row).toHaveTextContent(/^Deep Work/);
    expect(row.querySelector('svg.lucide-book-open')).toBeInTheDocument();
  });
});
