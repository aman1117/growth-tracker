import { describe, expect, it } from 'vitest';

import { PRESET_COLORS } from '../constants/colors';
import { readSrcFile } from '../test/fixtures/core';
import {
  contrastRatio,
  getOnColor,
  getOnColorTone,
  hexToRgb,
  ON_COLOR_DARK,
  ON_COLOR_LIGHT,
  relativeLuminance,
  withAlpha,
} from './color';

describe('hexToRgb', () => {
  it.each([
    ['#ff8000', { r: 255, g: 128, b: 0 }],
    ['FF8000', { r: 255, g: 128, b: 0 }],
    ['#f80', { r: 255, g: 136, b: 0 }],
    ['  #0a0B0c  ', { r: 10, g: 11, b: 12 }],
    ['#11223344', { r: 17, g: 34, b: 51 }],
  ])('parses %s', (hex, rgb) => {
    expect(hexToRgb(hex)).toEqual(rgb);
  });

  it.each(['var(--accent)', 'rgb(0, 0, 0)', '#12', '#ggg', ''])(
    'returns null for "%s"',
    (value) => {
      expect(hexToRgb(value)).toBeNull();
    }
  );
});

describe('relativeLuminance', () => {
  it.each([
    [{ r: 0, g: 0, b: 0 }, 0],
    [{ r: 255, g: 255, b: 255 }, 1],
    [{ r: 119, g: 119, b: 119 }, 0.1845],
    // Very dark channels use the linear part of the sRGB curve.
    [{ r: 10, g: 10, b: 10 }, 0.003035],
  ])('computes the WCAG luminance of %o', (rgb, luminance) => {
    expect(relativeLuminance(rgb)).toBeCloseTo(luminance, 4);
  });

  it('weights green more than red and red more than blue', () => {
    const red = relativeLuminance({ r: 255, g: 0, b: 0 });
    const green = relativeLuminance({ r: 0, g: 255, b: 0 });
    const blue = relativeLuminance({ r: 0, g: 0, b: 255 });

    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

describe('contrastRatio', () => {
  it('spans 1:1 to 21:1 and does not depend on argument order', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#6447f2', '#6447f2')).toBe(1);
    expect(contrastRatio('#777', '#fff')).toBeCloseTo(4.48, 2);
  });

  it('returns 1 when either color cannot be parsed', () => {
    expect(contrastRatio('var(--bg)', '#ffffff')).toBe(1);
    expect(contrastRatio('#ffffff', 'transparent')).toBe(1);
  });
});

describe('getOnColorTone / getOnColor', () => {
  it.each([
    ['brand violet', '#6447f2', 'light'],
    ['teal', '#0f766e', 'light'],
    ['black', '#000000', 'light'],
    ['amber', '#f59e0b', 'dark'],
    ['lime', '#84cc16', 'dark'],
    ['white', '#ffffff', 'dark'],
  ])('%s (%s) gets %s text', (_name, background, tone) => {
    expect(getOnColorTone(background)).toBe(tone);
    expect(getOnColor(background)).toBe(tone === 'light' ? ON_COLOR_LIGHT : ON_COLOR_DARK);
  });

  it('honours a stricter white-contrast threshold', () => {
    // White on blue-500 is ~3.7:1: fine for large text, not for the 4.5:1 body-text level.
    expect(getOnColorTone('#3b82f6')).toBe('light');
    expect(getOnColorTone('#3b82f6', 4.5)).toBe('dark');
  });

  it('falls back to dark ink for colors it cannot parse', () => {
    expect(getOnColor('var(--tile-color)')).toBe(ON_COLOR_DARK);
  });

  it('keeps text readable (>= 3:1) on every preset tile color', () => {
    PRESET_COLORS.forEach((background) => {
      expect(contrastRatio(getOnColor(background), background)).toBeGreaterThanOrEqual(3);
    });
  });

  it('uses the same ink as the --text-ink design token', () => {
    const tokensCss = readSrcFile('styles/tokens.css');

    expect(/--text-ink:\s*([^;]+);/.exec(tokensCss)?.[1].trim()).toBe(ON_COLOR_DARK);
  });
});

describe('withAlpha', () => {
  it('converts a hex color to rgba()', () => {
    expect(withAlpha('#6447f2', 0.2)).toBe('rgba(100, 71, 242, 0.2)');
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('clamps alpha to 0–1', () => {
    expect(withAlpha('#000000', 1.5)).toBe('rgba(0, 0, 0, 1)');
    expect(withAlpha('#000000', -1)).toBe('rgba(0, 0, 0, 0)');
  });

  it('returns unparsable colors unchanged', () => {
    expect(withAlpha('var(--accent)', 0.3)).toBe('var(--accent)');
  });
});
