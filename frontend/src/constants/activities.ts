/**
 * Activity Configuration
 * 
 * Centralized configuration for all activity types including icons, colors, and labels.
 * This eliminates duplication between Dashboard.tsx and AnalyticsPage.tsx.
 * Supports both predefined and custom activities.
 */

import {
  Moon,
  BookOpen,
  Utensils,
  Users,
  Sparkles,
  Dumbbell,
  Film,
  Home,
  Coffee,
  Palette,
  Plane,
  ShoppingBag,
  Sofa,
  Gamepad2,
  Briefcase,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ActivityName, PredefinedActivityName, CustomTile } from '../types';
import { isCustomTile, getCustomTileId, CUSTOM_TILE_PREFIX } from '../types';

export interface ActivityConfig {
  icon: LucideIcon | string; // LucideIcon for predefined, string (icon name) for custom
  color: string;
  label: string;
  isCustom?: boolean;
  iconName?: string; // Icon name string for dynamic loading (custom tiles)
}

/**
 * Default colors for predefined activities (for reset functionality)
 */
export const DEFAULT_ACTIVITY_COLORS: Record<PredefinedActivityName, string> = {
  sleep: '#6366f1',
  study: '#3b82f6',
  book_reading: '#0ea5e9',
  eating: '#f59e0b',
  friends: '#ec4899',
  grooming: '#8b5cf6',
  workout: '#ef4444',
  reels: '#f43f5e',
  family: '#10b981',
  idle: '#64748b',
  creative: '#d946ef',
  travelling: '#06b6d4',
  errand: '#f97316',
  rest: '#84cc16',
  entertainment: '#a855f7',
  office: '#0f766e',
};

/**
 * Configuration map for predefined activity types.
 * Contains icon component, color, and display label for each activity.
 */
export const ACTIVITY_CONFIG: Record<PredefinedActivityName, ActivityConfig> = {
  sleep: { icon: Moon, color: '#6366f1', label: 'Sleep' }, // Indigo
  study: { icon: BookOpen, color: '#3b82f6', label: 'Study' }, // Blue
  book_reading: { icon: BookOpen, color: '#0ea5e9', label: 'Reading' }, // Sky
  eating: { icon: Utensils, color: '#f59e0b', label: 'Eating' }, // Amber
  friends: { icon: Users, color: '#ec4899', label: 'Friends' }, // Pink
  grooming: { icon: Sparkles, color: '#8b5cf6', label: 'Grooming' }, // Violet
  workout: { icon: Dumbbell, color: '#ef4444', label: 'Workout' }, // Red
  reels: { icon: Film, color: '#f43f5e', label: 'Reels' }, // Rose
  family: { icon: Home, color: '#10b981', label: 'Family' }, // Emerald
  idle: { icon: Coffee, color: '#64748b', label: 'Idle' }, // Slate
  creative: { icon: Palette, color: '#d946ef', label: 'Creative' }, // Fuchsia
  travelling: { icon: Plane, color: '#06b6d4', label: 'Travelling' }, // Cyan
  errand: { icon: ShoppingBag, color: '#f97316', label: 'Errand' }, // Orange
  rest: { icon: Sofa, color: '#84cc16', label: 'Rest' }, // Lime
  entertainment: { icon: Gamepad2, color: '#a855f7', label: 'Entertainment' }, // Purple
  office: { icon: Briefcase, color: '#0f766e', label: 'Office' }, // Teal
};

/**
 * Get activity configuration with support for custom tiles and color overrides
 * @param name - The activity name (predefined or custom)
 * @param customTiles - Array of custom tile definitions
 * @param colorOverrides - Map of activity name to custom color
 */
export const getActivityConfig = (
  name: ActivityName,
  customTiles?: CustomTile[],
  colorOverrides?: Record<string, string>
): ActivityConfig => {
  // Handle custom tiles
  if (isCustomTile(name)) {
    const customId = getCustomTileId(name);
    const customTile = customTiles?.find(ct => ct.id === customId);
    
    if (customTile) {
      return {
        icon: customTile.icon, // Icon name as string for dynamic loading
        color: colorOverrides?.[name] || customTile.color,
        label: customTile.name,
        isCustom: true,
        iconName: customTile.icon, // Pass icon name for DynamicIcon
      };
    }
    
    // Fallback for unknown custom tile
    return {
      icon: 'Sparkles',
      color: colorOverrides?.[name] || '#64748b',
      label: 'Custom',
      isCustom: true,
      iconName: 'Sparkles',
    };
  }
  
  // Handle predefined activities
  const predefinedConfig = ACTIVITY_CONFIG[name as PredefinedActivityName];
  if (predefinedConfig) {
    return {
      ...predefinedConfig,
      color: colorOverrides?.[name] || predefinedConfig.color,
      isCustom: false,
    };
  }
  
  // Fallback for unknown activity
  return {
    icon: BookOpen,
    color: colorOverrides?.[name] || '#64748b',
    label: formatActivityName(name),
    isCustom: false,
  };
};

/**
 * Create activity name from custom tile ID
 */
export const createCustomActivityName = (customTileId: string): ActivityName => {
  return `${CUSTOM_TILE_PREFIX}${customTileId}` as ActivityName;
};

/**
 * Get the display label for an activity name
 */
export const getActivityLabel = (
  name: ActivityName,
  customTiles?: CustomTile[]
): string => {
  if (isCustomTile(name)) {
    const customId = getCustomTileId(name);
    const customTile = customTiles?.find(ct => ct.id === customId);
    return customTile?.name || 'Custom';
  }
  
  return ACTIVITY_CONFIG[name as PredefinedActivityName]?.label || formatActivityName(name);
};

/**
 * Format activity name to display format (fallback)
 * e.g., "book_reading" -> "Book Reading"
 */
export const formatActivityName = (name: string): string => {
  // Handle custom tile names
  if (isCustomTile(name)) {
    return 'Custom';
  }
  
  return name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * Get the icon component for a predefined activity
 * For custom tiles, use DynamicIcon component
 */
export const getActivityIcon = (name: PredefinedActivityName): LucideIcon => {
  return ACTIVITY_CONFIG[name]?.icon as LucideIcon || BookOpen;
};

/**
 * Get the color for an activity with optional override
 */
export const getActivityColor = (
  name: ActivityName,
  customTiles?: CustomTile[],
  colorOverrides?: Record<string, string>
): string => {
  // Check for override first
  if (colorOverrides?.[name]) {
    return colorOverrides[name];
  }
  
  // Handle custom tiles
  if (isCustomTile(name)) {
    const customId = getCustomTileId(name);
    const customTile = customTiles?.find(ct => ct.id === customId);
    return customTile?.color || '#64748b';
  }
  
  // Predefined activity
  return ACTIVITY_CONFIG[name as PredefinedActivityName]?.color || '#64748b';
};

/**
 * Get default color for an activity (ignoring overrides)
 */
export const getDefaultActivityColor = (
  name: ActivityName,
  customTiles?: CustomTile[]
): string => {
  if (isCustomTile(name)) {
    const customId = getCustomTileId(name);
    const customTile = customTiles?.find(ct => ct.id === customId);
    return customTile?.color || '#64748b';
  }
  
  return DEFAULT_ACTIVITY_COLORS[name as PredefinedActivityName] || '#64748b';
};
