import { describe, expect, it } from 'vitest';

import { ALL_ICONS, ICON_CATEGORIES } from './icons';

describe('icon catalogue', () => {
  it('lists every category icon, in category order, under "All"', () => {
    expect(ALL_ICONS).toEqual(Object.values(ICON_CATEGORIES).flat());
  });

  it('never lists an icon twice (names are used as React keys in the picker)', () => {
    const duplicates = ALL_ICONS.filter((name, index) => ALL_ICONS.indexOf(name) !== index);

    expect(duplicates).toEqual([]);
  });

  it('uses Lucide component names', () => {
    ALL_ICONS.forEach((name) => expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/));
  });

  it('has no empty categories', () => {
    Object.values(ICON_CATEGORIES).forEach((icons) => expect(icons.length).toBeGreaterThan(0));
  });
});
