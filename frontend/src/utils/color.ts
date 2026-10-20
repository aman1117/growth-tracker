/**
 * Color Utilities
 *
 * Pure helpers for working with user/activity colors (hex strings) so colored
 * surfaces always pick an accessible foreground and consistent tints.
 */

export type OnColorTone = 'light' | 'dark';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Ink used for text on bright activity colors (matches --text-ink) */
export const ON_COLOR_DARK = '#15122a';
/** Text used on deep activity colors */
export const ON_COLOR_LIGHT = '#ffffff';

/**
 * Parses #rgb / #rrggbb (with or without '#'). Returns null for anything else
 * (e.g. CSS variables or rgb() strings), letting callers fall back gracefully.
 */
export const hexToRgb = (hex: string): Rgb | null => {
  const value = hex.trim().replace(/^#/, '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
};

const channelToLinear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** WCAG relative luminance (0 = black, 1 = white) */
export const relativeLuminance = ({ r, g, b }: Rgb): number =>
  0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);

/** WCAG contrast ratio between two hex colors (1–21). Returns 1 when unparsable. */
export const contrastRatio = (a: string, b: string): number => {
  const rgbA = hexToRgb(a);
  const rgbB = hexToRgb(b);
  if (!rgbA || !rgbB) return 1;
  const [hi, lo] = [relativeLuminance(rgbA), relativeLuminance(rgbB)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Picks the foreground tone for text placed on a solid `background` color.
 * White is preferred (it reads as more vibrant) whenever it reaches the
 * large-text threshold; bright colors (amber, lime, cyan…) get dark ink instead.
 */
export const getOnColorTone = (background: string, minWhiteContrast = 3): OnColorTone =>
  contrastRatio(ON_COLOR_LIGHT, background) >= minWhiteContrast ? 'light' : 'dark';

/** Concrete text color for content on a solid `background` */
export const getOnColor = (background: string): string =>
  getOnColorTone(background) === 'light' ? ON_COLOR_LIGHT : ON_COLOR_DARK;

/** `#rrggbb` + alpha (0–1) → rgba() string; falls back to the input when unparsable */
export const withAlpha = (hex: string, alpha: number): string => {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
};
