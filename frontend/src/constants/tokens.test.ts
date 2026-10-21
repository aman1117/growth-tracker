import { describe, expect, it } from 'vitest';

import { readSrcFile } from '../test/fixtures/core';
import tokens, {
  BREAKPOINTS,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  CARD_VARIANTS,
  cssVar,
  EASINGS,
  FONT_SIZE,
  FONT_WEIGHT,
  getThemedValue,
  GLASS,
  INPUT_VARIANTS,
  LINE_HEIGHT,
  RADII,
  SEMANTIC_COLORS,
  SHADOWS,
  SHADOWS_DARK,
  SPACING,
  TRANSITIONS,
  TYPOGRAPHY_ROLES,
  Z_INDEX,
} from './tokens';

/** The first (theme-independent) declaration of every custom property in tokens.css. */
const cssVariables = new Map<string, string>();
for (const [, name, value] of readSrcFile('styles/tokens.css').matchAll(
  /(--[\w-]+)\s*:\s*([^;]+);/g
)) {
  if (!cssVariables.has(name)) cssVariables.set(name, value.trim());
}

/** Resolves `var(--alias)` chains to the final value. */
function cssValue(name: string): string {
  const value = cssVariables.get(name);
  if (value === undefined) throw new Error(`${name} is not defined in tokens.css`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias ? cssValue(alias[1]) : value;
}

/** `modalBackdrop` → `modal-backdrop`, `0.5` → `0-5` */
const toCssName = (key: string) =>
  key.replace(/\./g, '-').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

describe('design tokens mirror tokens.css', () => {
  it.each([
    ['SPACING', SPACING, '--space-'],
    ['RADII', RADII, '--radius-'],
    ['FONT_SIZE', FONT_SIZE, '--text-'],
    ['LINE_HEIGHT', LINE_HEIGHT, '--leading-'],
    ['FONT_WEIGHT', FONT_WEIGHT, '--font-'],
    ['TRANSITIONS', TRANSITIONS, '--transition-'],
    ['EASINGS', EASINGS, '--ease-'],
    ['Z_INDEX', Z_INDEX, '--z-'],
  ] as const)('%s matches the %s* custom properties', (_name, scale, prefix) => {
    Object.entries(scale).forEach(([key, value]) => {
      expect({ key, value: cssValue(`${prefix}${toCssName(key)}`) }).toEqual({
        key,
        value: String(value),
      });
    });
  });

  it('TYPOGRAPHY_ROLES match the --type-* roles', () => {
    Object.entries(TYPOGRAPHY_ROLES).forEach(([role, style]) => {
      const prefix = `--type-${toCssName(role)}`;
      expect({
        role,
        size: cssValue(`${prefix}-size`),
        weight: cssValue(`${prefix}-weight`),
        lineHeight: cssValue(`${prefix}-leading`),
        letterSpacing: cssValue(`${prefix}-tracking`),
      }).toEqual({
        role,
        size: style.size,
        weight: String(style.weight),
        lineHeight: String(style.lineHeight),
        letterSpacing: style.letterSpacing,
      });
    });
  });
});

describe('design token scales', () => {
  const ascending = (values: number[]) =>
    values.every((value, i) => i === 0 || value > values[i - 1]);

  it('stacks layers in a strictly increasing z-order', () => {
    expect(ascending(Object.values(Z_INDEX))).toBe(true);
    expect(Z_INDEX.modal).toBeGreaterThan(Z_INDEX.modalBackdrop);
    expect(Z_INDEX.toast).toBeGreaterThan(Z_INDEX.modal);
  });

  it('orders breakpoints, transitions and button sizes from small to large', () => {
    expect(ascending(Object.values(BREAKPOINTS))).toBe(true);
    expect(ascending(Object.values(TRANSITIONS).map((ms) => parseInt(ms, 10)))).toBe(true);
    expect(ascending(Object.values(BUTTON_SIZES).map((size) => parseFloat(size.height)))).toBe(
      true
    );
  });

  it('defines every shadow for both themes', () => {
    expect(Object.keys(SHADOWS_DARK)).toEqual(Object.keys(SHADOWS));
  });

  it('defines every glass surface for both themes', () => {
    Object.values(GLASS)
      .filter((group) => 'light' in group)
      .forEach((group) => {
        const { light, dark } = group as { light: object; dark: object };
        expect(Object.keys(dark)).toEqual(Object.keys(light));
      });
  });

  it('defines every semantic color as hex for both themes', () => {
    Object.values(SEMANTIC_COLORS).forEach(({ light, dark }) => {
      expect(light).toMatch(/^#[0-9a-f]{6}$/);
      expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    });
  });

  it('lists unique component variants', () => {
    [BUTTON_VARIANTS, CARD_VARIANTS, INPUT_VARIANTS].forEach((variants) =>
      expect(new Set(variants).size).toBe(variants.length)
    );
  });
});

describe('token helpers', () => {
  it('picks the value for the active theme', () => {
    expect(getThemedValue(SEMANTIC_COLORS, 'error', 'light')).toBe('#cc2b37');
    expect(getThemedValue(SEMANTIC_COLORS, 'error', 'dark')).toBe('#ff6b72');
  });

  it('builds CSS variable references with an optional fallback', () => {
    expect(cssVar('color-primary')).toBe('var(--color-primary)');
    expect(cssVar('color-primary', '#6447f2')).toBe('var(--color-primary, #6447f2)');
  });

  it('bundles the token groups in the default export', () => {
    expect(tokens).toMatchObject({ SPACING, RADII, FONT_SIZE, Z_INDEX, BREAKPOINTS, GLASS });
    expect(tokens.SPACING).toBe(SPACING);
  });
});
