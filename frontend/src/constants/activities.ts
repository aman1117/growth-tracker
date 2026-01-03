/**
 * Activity Configuration
 * 
 * Centralized configuration for all activity types including icons, colors, and labels.
 * This eliminates duplication between Dashboard.tsx and AnalyticsPage.tsx.
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
import type { ActivityName } from '../types';

export interface ActivityConfig {
  icon: LucideIcon;
  color: string;
  label: string;
}

/**
 * Configuration map for all activity types.
 * Contains icon component, color, and display label for each activity.
 */
export const ACTIVITY_CONFIG: Record<ActivityName, ActivityConfig> = {
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
 * Get the display label for an activity name
 */
export const getActivityLabel = (name: ActivityName): string => {
  return ACTIVITY_CONFIG[name]?.label || formatActivityName(name);
};

/**
 * Format activity name to display format (fallback)
 * e.g., "book_reading" -> "Book Reading"
 */
export const formatActivityName = (name: string): string => {
  return name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * Get the icon component for an activity
 */
export const getActivityIcon = (name: ActivityName): LucideIcon => {
  return ACTIVITY_CONFIG[name]?.icon || BookOpen;
};

/**
 * Get the color for an activity
 */
export const getActivityColor = (name: ActivityName): string => {
  return ACTIVITY_CONFIG[name]?.color || '#64748b';
};
