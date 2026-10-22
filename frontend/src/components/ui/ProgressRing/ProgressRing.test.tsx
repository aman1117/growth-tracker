import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProgressRing } from './ProgressRing';

const indicator = (container: HTMLElement) => container.querySelectorAll('circle')[1];

describe('ProgressRing', () => {
  it('is a labelled progressbar that announces its value', () => {
    render(<ProgressRing value={5} max={20} label="Days met" valueText="5 of 20 days" />);

    const ring = screen.getByRole('progressbar', { name: 'Days met' });
    expect(ring).toHaveAttribute('aria-valuemin', '0');
    expect(ring).toHaveAttribute('aria-valuemax', '100');
    expect(ring).toHaveAttribute('aria-valuenow', '25');
    expect(ring).toHaveAttribute('aria-valuetext', '5 of 20 days');
  });

  it('announces the percentage when there is no value text', () => {
    render(<ProgressRing value={1} max={3} label="Progress" />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '33%');
  });

  it('fills the ring in proportion to the value', () => {
    const { container } = render(
      <ProgressRing value={3} max={4} label="Progress" size={100} strokeWidth={10} />
    );

    const circumference = 2 * Math.PI * 45;
    const circle = indicator(container);
    expect(circle).toHaveAttribute('r', '45');
    expect(Number(circle.getAttribute('stroke-dasharray'))).toBeCloseTo(circumference);
    expect(Number(circle.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference / 4);
    expect(circle).toHaveAttribute('opacity', '1');
  });

  it.each([
    ['nothing done yet', 0, 10, 0],
    ['an empty goal', 4, 0, 0],
    ['a negative value', -2, 10, 0],
    ['more than the goal', 15, 10, 100],
    ['a value that is not a number', Number.NaN, 10, 0],
  ])('clamps %s', (_label, value, max, percent) => {
    const { container } = render(<ProgressRing value={value} max={max} label="Progress" />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(percent));
    expect(indicator(container)).toHaveAttribute('opacity', percent > 0 ? '1' : '0');
  });

  it('shows centered content without announcing it twice', () => {
    render(
      <ProgressRing value={5} max={21} label="Days met" valueText="5 of 21 days">
        <strong>5</strong>/21
      </ProgressRing>
    );

    const content = screen.getByText('5').parentElement;
    expect(content).toHaveAttribute('aria-hidden', 'true');
    expect(content).toHaveTextContent('5/21');
  });

  it('renders no content wrapper without children', () => {
    const { container } = render(<ProgressRing value={1} max={2} label="Progress" />);

    expect(container.querySelector('[aria-hidden="true"]:not(svg)')).toBeNull();
  });

  it('applies the size, color and class name', () => {
    render(
      <ProgressRing
        value={1}
        max={2}
        label="Progress"
        size={64}
        color="#22c55e"
        className="custom"
      />
    );

    const ring = screen.getByRole('progressbar');
    expect(ring).toHaveClass('custom');
    expect(ring).toHaveStyle({ width: '64px', height: '64px' });
    expect(ring.style.getPropertyValue('--progress-ring-color')).toBe('#22c55e');
  });

  it('uses the theme accent unless a color is given', () => {
    render(<ProgressRing value={1} max={2} label="Progress" />);

    expect(screen.getByRole('progressbar').style.getPropertyValue('--progress-ring-color')).toBe(
      ''
    );
  });
});
