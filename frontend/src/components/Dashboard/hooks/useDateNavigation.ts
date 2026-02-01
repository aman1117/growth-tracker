/**
 * useDateNavigation Hook
 *
 * Manages date navigation state and animations for the dashboard.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { getDateFromSearchParams, TILE_ANIMATION_DELAY, TILE_ANIMATION_DURATION } from '../Dashboard.constants';

interface UseDateNavigationReturn {
  currentDate: Date;
  setCurrentDate: React.Dispatch<React.SetStateAction<Date>>;
  handlePrevDay: () => void;
  handleNextDay: () => void;
  handleDateChange: (newDate: Date) => void;
  isNextDisabled: () => boolean;
  tilesAnimating: boolean;
  animationDirection: 'left' | 'right';
}

export const useDateNavigation = (): UseDateNavigationReturn => {
  const [searchParams] = useSearchParams();

  // Initialize date from URL param or default to today
  const [currentDate, setCurrentDate] = useState(() => {
    return getDateFromSearchParams(searchParams) || new Date();
  });

  // Tile animation state for day transitions
  const [tilesAnimating, setTilesAnimating] = useState(false);
  const [animationDirection, setAnimationDirection] = useState<'left' | 'right'>('left');

  // Sync date state when URL search params change (e.g., from notification click)
  useEffect(() => {
    const urlDate = getDateFromSearchParams(searchParams);
    if (urlDate) {
      const currentNorm = new Date(currentDate);
      currentNorm.setHours(0, 0, 0, 0);
      urlDate.setHours(0, 0, 0, 0);

      // Only update if the dates are different
      if (currentNorm.getTime() !== urlDate.getTime()) {
        setCurrentDate(urlDate);
      }
    }
    // currentDate is intentionally excluded to prevent infinite loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handlePrevDay = () => {
    setAnimationDirection('right');
    setTilesAnimating(true);
    setTimeout(() => {
      const newDate = new Date(currentDate);
      newDate.setDate(newDate.getDate() - 1);
      setCurrentDate(newDate);
      setTimeout(() => setTilesAnimating(false), TILE_ANIMATION_DELAY);
    }, TILE_ANIMATION_DURATION);
  };

  const handleNextDay = () => {
    setAnimationDirection('left');
    setTilesAnimating(true);
    setTimeout(() => {
      const newDate = new Date(currentDate);
      newDate.setDate(newDate.getDate() + 1);
      setCurrentDate(newDate);
      setTimeout(() => setTilesAnimating(false), TILE_ANIMATION_DELAY);
    }, TILE_ANIMATION_DURATION);
  };

  const handleDateChange = (newDate: Date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(newDate);
    targetDate.setHours(0, 0, 0, 0);
    const currentDateNorm = new Date(currentDate);
    currentDateNorm.setHours(0, 0, 0, 0);

    // Determine animation direction based on date comparison
    if (targetDate < currentDateNorm) {
      setAnimationDirection('right');
    } else if (targetDate > currentDateNorm) {
      setAnimationDirection('left');
    }

    setTilesAnimating(true);
    setTimeout(() => {
      setCurrentDate(newDate);
      setTimeout(() => setTilesAnimating(false), TILE_ANIMATION_DELAY);
    }, TILE_ANIMATION_DURATION);
  };

  const isNextDisabled = () => {
    const today = new Date();
    return currentDate.toDateString() === today.toDateString() || currentDate > today;
  };

  return {
    currentDate,
    setCurrentDate,
    handlePrevDay,
    handleNextDay,
    handleDateChange,
    isNextDisabled,
    tilesAnimating,
    animationDirection,
  };
};
