import { describe, expect, it } from 'vitest';

import type { CustomTile } from '../types';
import { isPlainObject, tileExtrasFromConfig } from './tileConfig';

const guitar: CustomTile = { id: 'g1', name: 'Guitar', icon: 'Music', color: '#ff00aa' };
const none = { hidden: [], colors: {}, customTiles: [] };

describe('isPlainObject', () => {
  it.each([{}, { sleep: '#111111' }])('accepts %j', (value) => {
    expect(isPlainObject(value)).toBe(true);
  });

  it.each([null, undefined, [], ['sleep'], 'sleep', 3])('rejects %j', (value) => {
    expect(isPlainObject(value)).toBe(false);
  });
});

describe('tileExtrasFromConfig', () => {
  it('reads the hidden tiles, colors and custom tiles a saved config holds', () => {
    const config = {
      order: ['custom:g1', 'sleep'],
      sizes: { sleep: 'wide' },
      hidden: ['reels'],
      colors: { sleep: '#111111' },
      customTiles: [guitar],
    };

    expect(tileExtrasFromConfig(config)).toEqual({
      hidden: ['reels'],
      colors: { sleep: '#111111' },
      customTiles: [guitar],
    });
  });

  it('treats a part the config leaves out as none', () => {
    expect(tileExtrasFromConfig({ order: ['sleep'], sizes: { sleep: 'wide' } })).toEqual(none);
    expect(tileExtrasFromConfig({ colors: { sleep: '#111111' } })).toEqual({
      ...none,
      colors: { sleep: '#111111' },
    });
  });

  it.each([null, undefined, 'oops', [guitar]])('treats %j as no saved config', (config) => {
    expect(tileExtrasFromConfig(config)).toEqual(none);
  });

  it('treats malformed parts as none', () => {
    expect(
      tileExtrasFromConfig({ hidden: 'reels', colors: ['#111111'], customTiles: { guitar } })
    ).toEqual(none);
    expect(tileExtrasFromConfig({ hidden: null, colors: null, customTiles: null })).toEqual(none);
  });
});
