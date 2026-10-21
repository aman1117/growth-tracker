import { describe, expect, it } from 'vitest';

import { DEFAULT_TILE_COLOR, PRESET_COLOR_OPTIONS, PRESET_COLORS } from './colors';

describe('color presets', () => {
  it('offers distinct, persistable hex colors with distinct names', () => {
    const values = PRESET_COLOR_OPTIONS.map((option) => option.value);
    const names = PRESET_COLOR_OPTIONS.map((option) => option.name);

    values.forEach((value) => expect(value).toMatch(/^#[0-9a-f]{6}$/));
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes the preset values in palette order', () => {
    expect(PRESET_COLORS).toEqual(PRESET_COLOR_OPTIONS.map((option) => option.value));
  });

  it('defaults new custom tiles to a preset color', () => {
    expect(PRESET_COLOR_OPTIONS.find((option) => option.value === DEFAULT_TILE_COLOR)?.name).toBe(
      'Violet'
    );
  });
});
