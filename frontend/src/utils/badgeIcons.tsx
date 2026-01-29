/**
 * Badge Icon Utilities
 *
 * Shared icon mapping for badge components to ensure consistency.
 */

import type { LucideIcon } from 'lucide-react';
import { Crown, Flame, Footprints, Gem, Shield, Star, Zap } from 'lucide-react';
import React from 'react';

// Map badge icon names to Lucide components
export const badgeIconComponents: Record<string, LucideIcon> = {
  Footprints,
  Zap,
  Flame,
  Shield,
  Gem,
  Crown,
  Star,
};

// Get badge icon component by name
export const getBadgeIconComponent = (iconName: string): LucideIcon => {
  return badgeIconComponents[iconName] || Star;
};

// Render badge icon with consistent styling
export const renderBadgeIcon = (
  iconName: string,
  color: string,
  size: number = 18,
  filled: boolean = true
): React.ReactNode => {
  const IconComponent = getBadgeIconComponent(iconName);
  return (
    <IconComponent
      size={size}
      fill={filled ? color : 'none'}
      color={color}
      style={{ display: 'block' }}
    />
  );
};
