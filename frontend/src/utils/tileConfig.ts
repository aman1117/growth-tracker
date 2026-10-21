/**
 * Reading the tile config saved for an account the same way on every screen. Saving leaves out
 * the hidden tiles, color overrides and custom tiles when there are none, so a part the config
 * lacks means none. It never means "keep what this device has": devices would then show
 * different tiles.
 */

import type { ActivityName, CustomTile } from '../types';

/** The parts of a saved tile config that saving leaves out when they are empty */
export interface TileExtras {
  hidden: ActivityName[];
  colors: Record<string, string>;
  customTiles: CustomTile[];
}

/** Whether `value` is a non-null object that is not an array, such as a parsed JSON object */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The hidden tiles, color overrides and custom tiles in a saved tile config. A part that is
 * missing or malformed, or no config at all (`null`), means none.
 */
export const tileExtrasFromConfig = (config: unknown): TileExtras => {
  const { hidden, colors, customTiles }: Record<string, unknown> = isPlainObject(config)
    ? config
    : {};
  return {
    hidden: Array.isArray(hidden) ? (hidden as ActivityName[]) : [],
    colors: isPlainObject(colors) ? (colors as Record<string, string>) : {},
    customTiles: Array.isArray(customTiles) ? (customTiles as CustomTile[]) : [],
  };
};
