import * as lucide from 'lucide-react';
import { BookOpen, Moon, Sparkles } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { ACTIVITY_NAMES, type ActivityName, type CustomTile, getCustomTileId } from '../types';
import {
  ACTIVITY_CONFIG,
  createCustomActivityName,
  DEFAULT_ACTIVITY_COLORS,
  formatActivityName,
  getActivityColor,
  getActivityConfig,
  getActivityIcon,
  getActivityLabel,
  getDefaultActivityColor,
} from './activities';
import { PRESET_COLORS } from './colors';

const SLATE = '#64748b';
const cycling: CustomTile = { id: 'tile-1', name: 'Cycling', icon: 'Bike', color: '#10b981' };
const tiles = [cycling];
const CYCLING: ActivityName = 'custom:tile-1';
const MISSING: ActivityName = 'custom:deleted-tile';
// An activity name the backend may send that this client version does not know yet.
const UNKNOWN = 'deep_work' as ActivityName;

describe('activity catalogue', () => {
  it('configures exactly the predefined activities', () => {
    expect(Object.keys(ACTIVITY_CONFIG).sort()).toEqual([...ACTIVITY_NAMES].sort());
    expect(Object.keys(DEFAULT_ACTIVITY_COLORS).sort()).toEqual([...ACTIVITY_NAMES].sort());
  });

  it('restores the shipped color when a color override is reset', () => {
    ACTIVITY_NAMES.forEach((name) => {
      expect(DEFAULT_ACTIVITY_COLORS[name]).toBe(ACTIVITY_CONFIG[name].color);
    });
  });

  it('only uses default colors that the color picker offers', () => {
    Object.values(DEFAULT_ACTIVITY_COLORS).forEach((color) => {
      expect(PRESET_COLORS).toContain(color);
    });
  });

  it('gives every activity a distinct label', () => {
    const labels = Object.values(ACTIVITY_CONFIG).map((config) => config.label);

    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names each activity's icon by the Lucide export it renders", () => {
    Object.values(ACTIVITY_CONFIG).forEach(({ icon, iconName }) => {
      expect((lucide as Record<string, unknown>)[iconName ?? '']).toBe(icon);
    });
  });
});

describe('getActivityConfig', () => {
  it('returns the predefined configuration', () => {
    expect(getActivityConfig('sleep')).toEqual({
      icon: Moon,
      color: '#6366f1',
      label: 'Sleep',
      iconName: 'Moon',
      isCustom: false,
    });
  });

  it('applies a color override to a predefined activity', () => {
    expect(getActivityConfig('sleep', [], { sleep: '#000000' }).color).toBe('#000000');
  });

  it('describes a custom tile by its icon name, color and label', () => {
    expect(getActivityConfig(CYCLING, tiles)).toEqual({
      icon: 'Bike',
      iconName: 'Bike',
      color: '#10b981',
      label: 'Cycling',
      isCustom: true,
    });
    expect(getActivityConfig(CYCLING, tiles, { [CYCLING]: '#ef4444' }).color).toBe('#ef4444');
  });

  it('falls back to a generic custom tile when its definition is missing', () => {
    expect(getActivityConfig(MISSING)).toEqual({
      icon: 'Sparkles',
      iconName: 'Sparkles',
      color: SLATE,
      label: 'Custom',
      isCustom: true,
    });
    expect(getActivityConfig(MISSING, tiles, { [MISSING]: '#f97316' }).color).toBe('#f97316');
  });

  it('falls back to a readable label for unknown activities', () => {
    expect(getActivityConfig(UNKNOWN)).toEqual({
      icon: BookOpen,
      color: SLATE,
      label: 'Deep Work',
      isCustom: false,
    });
    expect(getActivityConfig(UNKNOWN, [], { deep_work: '#0ea5e9' }).color).toBe('#0ea5e9');
  });
});

describe('activity helpers', () => {
  it('builds custom activity names that round-trip to the tile id', () => {
    const name = createCustomActivityName('tile-9');

    expect(name).toBe('custom:tile-9');
    expect(getCustomTileId(name)).toBe('tile-9');
  });

  it.each<[ActivityName, string, CustomTile[] | undefined]>([
    ['book_reading', 'Reading', undefined],
    [CYCLING, 'Cycling', tiles],
    [MISSING, 'Custom', tiles],
    [CYCLING, 'Custom', undefined],
    [UNKNOWN, 'Deep Work', undefined],
  ])('labels %s as "%s"', (name, label, customTiles) => {
    expect(getActivityLabel(name, customTiles)).toBe(label);
  });

  it.each([
    ['book_reading', 'Book Reading'],
    ['yoga', 'Yoga'],
    ['custom:tile-1', 'Custom'],
  ])('formats %s as "%s"', (name, label) => {
    expect(formatActivityName(name)).toBe(label);
  });

  it('returns the icon component for predefined activities', () => {
    expect(getActivityIcon('sleep')).toBe(Moon);
    expect(getActivityIcon('grooming')).toBe(Sparkles);
    expect(getActivityIcon('deep_work' as never)).toBe(BookOpen);
  });

  it.each<[string, ActivityName, Record<string, string> | undefined, string]>([
    ['an override', 'sleep', { sleep: '#000000' }, '#000000'],
    ['a predefined activity', 'workout', undefined, '#ef4444'],
    ['a custom tile', CYCLING, undefined, '#10b981'],
    ['a missing custom tile', MISSING, undefined, SLATE],
    ['an unknown activity', UNKNOWN, {}, SLATE],
  ])('getActivityColor picks the color of %s', (_label, name, overrides, color) => {
    expect(getActivityColor(name, tiles, overrides)).toBe(color);
  });

  it.each<[ActivityName, string, CustomTile[] | undefined]>([
    ['workout', '#ef4444', undefined],
    [CYCLING, '#10b981', tiles],
    [MISSING, SLATE, tiles],
    [CYCLING, SLATE, undefined],
    [UNKNOWN, SLATE, undefined],
  ])('getDefaultActivityColor(%s) is %s', (name, color, customTiles) => {
    expect(getDefaultActivityColor(name, customTiles)).toBe(color);
  });
});
