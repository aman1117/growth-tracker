/**
 * Color Constants
 *
 * Preset color palette for activity tiles and custom components.
 */

export interface PresetColorOption {
  value: string;
  name: string;
}

// Preset palette (hue ordered). Values are persisted on tiles, so keep them stable.
export const PRESET_COLOR_OPTIONS: PresetColorOption[] = [
  { value: '#3b82f6', name: 'Blue' },
  { value: '#0ea5e9', name: 'Sky' },
  { value: '#06b6d4', name: 'Cyan' },
  { value: '#10b981', name: 'Emerald' },
  { value: '#84cc16', name: 'Lime' },
  { value: '#f59e0b', name: 'Amber' },
  { value: '#f97316', name: 'Orange' },
  { value: '#ef4444', name: 'Red' },
  { value: '#f43f5e', name: 'Rose' },
  { value: '#ec4899', name: 'Pink' },
  { value: '#d946ef', name: 'Fuchsia' },
  { value: '#a855f7', name: 'Purple' },
  { value: '#8b5cf6', name: 'Violet' },
  { value: '#6366f1', name: 'Indigo' },
  { value: '#0f766e', name: 'Teal' },
  { value: '#64748b', name: 'Slate' },
];

export const PRESET_COLORS: string[] = PRESET_COLOR_OPTIONS.map((option) => option.value);

/** Default color for new custom tiles (closest preset to the brand violet) */
export const DEFAULT_TILE_COLOR = '#8b5cf6';
