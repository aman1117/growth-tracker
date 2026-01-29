/**
 * UI Constants
 *
 * Centralized UI-related constants like animation durations,
 * debounce times, and other magic numbers.
 */

export const ANIMATION = {
  /** Page transition duration in ms */
  PAGE_TRANSITION: 200,
  /** Slide animation duration in ms */
  SLIDE_DURATION: 250,
  /** Toast auto-hide duration in ms */
  TOAST_DURATION: 3000,
  /** Stat counter animation delay in ms */
  STATS_DELAY: 100,
  /** Bar chart animation delay in ms */
  BARS_DELAY: 300,
} as const;

export const DEBOUNCE = {
  /** Search input debounce in ms */
  SEARCH: 300,
  /** Window resize debounce in ms */
  RESIZE: 150,
} as const;

export const BREAKPOINTS = {
  /** Mobile breakpoint in px */
  MOBILE: 480,
  /** Tablet breakpoint in px */
  TABLET: 768,
  /** Desktop breakpoint in px */
  DESKTOP: 1024,
} as const;
