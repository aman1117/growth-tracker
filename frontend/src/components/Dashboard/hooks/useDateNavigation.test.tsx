import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXED_TODAY } from '../../../test/fixtures/dashboard';
import { TILE_ANIMATION_DELAY, TILE_ANIMATION_DURATION } from '../Dashboard.constants';
import { useDateNavigation } from './useDateNavigation';

function renderDateNavigation(route = '/') {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  );
  return renderHook(() => ({ ...useDateNavigation(), navigate: useNavigate() }), { wrapper });
}

const dayOf = (date: Date) => date.toDateString();
const daysAgo = (days: number) => {
  const date = new Date(FIXED_TODAY);
  date.setDate(date.getDate() - days);
  return date;
};

describe('useDateNavigation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TODAY);
  });

  it('starts on today and does not allow moving into the future', () => {
    const { result } = renderDateNavigation();

    expect(dayOf(result.current.currentDate)).toBe(dayOf(FIXED_TODAY));
    expect(result.current.isNextDisabled()).toBe(true);
    expect(result.current.tilesAnimating).toBe(false);
  });

  it('opens the day from a valid ?date= link', () => {
    const { result } = renderDateNavigation('/?date=2026-05-10');

    expect(result.current.currentDate).toEqual(new Date(2026, 4, 10));
    expect(result.current.isNextDisabled()).toBe(false);
  });

  it('ignores a ?date= link to the future', () => {
    const { result } = renderDateNavigation('/?date=2026-06-01');

    expect(dayOf(result.current.currentDate)).toBe(dayOf(FIXED_TODAY));
  });

  it('slides to the previous day, then finishes the animation', () => {
    const { result } = renderDateNavigation();

    act(() => result.current.handlePrevDay());
    expect(result.current.tilesAnimating).toBe(true);
    expect(result.current.animationDirection).toBe('right');
    expect(dayOf(result.current.currentDate)).toBe(dayOf(FIXED_TODAY));

    act(() => void vi.advanceTimersByTime(TILE_ANIMATION_DURATION));
    expect(dayOf(result.current.currentDate)).toBe(dayOf(daysAgo(1)));
    expect(result.current.tilesAnimating).toBe(true);

    act(() => void vi.advanceTimersByTime(TILE_ANIMATION_DELAY));
    expect(result.current.tilesAnimating).toBe(false);
    expect(result.current.isNextDisabled()).toBe(false);
  });

  it('slides forward to the next day', () => {
    const { result } = renderDateNavigation('/?date=2026-05-13');

    act(() => result.current.handleNextDay());
    expect(result.current.animationDirection).toBe('left');

    act(() => void vi.advanceTimersByTime(TILE_ANIMATION_DURATION + TILE_ANIMATION_DELAY));
    expect(result.current.currentDate).toEqual(new Date(2026, 4, 14));
    expect(result.current.tilesAnimating).toBe(false);
  });

  it('animates a picked date in the direction of travel', () => {
    const { result } = renderDateNavigation('/?date=2026-05-10');

    act(() => result.current.handleDateChange(new Date(2026, 4, 1)));
    expect(result.current.animationDirection).toBe('right');
    act(() => void vi.advanceTimersByTime(TILE_ANIMATION_DURATION + TILE_ANIMATION_DELAY));
    expect(result.current.currentDate).toEqual(new Date(2026, 4, 1));

    act(() => result.current.handleDateChange(new Date(2026, 4, 12)));
    expect(result.current.animationDirection).toBe('left');
    act(() => void vi.advanceTimersByTime(TILE_ANIMATION_DURATION + TILE_ANIMATION_DELAY));
    expect(result.current.currentDate).toEqual(new Date(2026, 4, 12));
  });

  it('keeps the direction when the picked date is the current day', () => {
    const { result } = renderDateNavigation('/?date=2026-05-10');

    act(() => result.current.handleDateChange(new Date(2026, 4, 1)));
    act(() => void vi.advanceTimersByTime(TILE_ANIMATION_DURATION + TILE_ANIMATION_DELAY));
    act(() => result.current.handleDateChange(new Date(2026, 4, 1, 18)));

    expect(result.current.animationDirection).toBe('right');
    expect(result.current.tilesAnimating).toBe(true);
  });

  it('follows a new ?date= link (e.g. a notification tap) while mounted', () => {
    const { result } = renderDateNavigation();

    act(() => result.current.navigate('/?date=2026-05-11'));

    expect(result.current.currentDate).toEqual(new Date(2026, 4, 11));
  });

  it('keeps the current day when the link points at the same day or is invalid', () => {
    const { result } = renderDateNavigation('/?date=2026-05-11');
    const before = result.current.currentDate;

    act(() => result.current.navigate('/?date=2026-05-11&comments=true'));
    expect(result.current.currentDate).toBe(before);

    act(() => result.current.navigate('/?date=garbage'));
    expect(result.current.currentDate).toBe(before);
  });

  it('treats any day after today as not navigable forward', () => {
    const { result } = renderDateNavigation();

    act(() => result.current.setCurrentDate(new Date(2026, 4, 20)));

    expect(result.current.isNextDisabled()).toBe(true);
  });
});
