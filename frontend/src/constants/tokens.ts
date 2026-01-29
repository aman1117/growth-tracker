/**
 * Design Tokens (TypeScript)
 *
 * Type-safe design tokens that mirror CSS custom properties.
 * Use these for runtime calculations, dynamic styles, and TypeScript integration.
 */

// ============================================================================
// Spacing Scale
// ============================================================================

export const SPACING = {
  0: '0',
  px: '1px',
  0.5: '0.125rem', // 2px
  1: '0.25rem', // 4px
  1.5: '0.375rem', // 6px
  2: '0.5rem', // 8px
  2.5: '0.625rem', // 10px
  3: '0.75rem', // 12px
  3.5: '0.875rem', // 14px
  4: '1rem', // 16px
  5: '1.25rem', // 20px
  6: '1.5rem', // 24px
  7: '1.75rem', // 28px
  8: '2rem', // 32px
  9: '2.25rem', // 36px
  10: '2.5rem', // 40px
  11: '2.75rem', // 44px
  12: '3rem', // 48px
  14: '3.5rem', // 56px
  16: '4rem', // 64px
} as const;

export type SpacingKey = keyof typeof SPACING;

// ============================================================================
// Border Radius
// ============================================================================

export const RADII = {
  none: '0',
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  '2xl': '20px',
  '3xl': '24px',
  full: '9999px',
} as const;

export type RadiiKey = keyof typeof RADII;

// ============================================================================
// Typography
// ============================================================================

export const FONT_SIZE = {
  '2xs': '0.625rem', // 10px
  xs: '0.75rem', // 12px
  sm: '0.8125rem', // 13px
  base: '0.875rem', // 14px
  md: '1rem', // 16px
  lg: '1.125rem', // 18px
  xl: '1.25rem', // 20px
  '2xl': '1.5rem', // 24px
  '3xl': '1.875rem', // 30px
  '4xl': '2.25rem', // 36px
} as const;

export type FontSizeKey = keyof typeof FONT_SIZE;

export const LINE_HEIGHT = {
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
} as const;

export type LineHeightKey = keyof typeof LINE_HEIGHT;

export const FONT_WEIGHT = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export type FontWeightKey = keyof typeof FONT_WEIGHT;

// ============================================================================
// Shadows
// ============================================================================

export const SHADOWS = {
  none: 'none',
  subtle: '0 1px 2px rgba(0, 0, 0, 0.04)',
  sm: '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)',
  md: '0 4px 6px rgba(0, 0, 0, 0.07), 0 2px 4px rgba(0, 0, 0, 0.05)',
  lg: '0 10px 15px rgba(0, 0, 0, 0.08), 0 4px 6px rgba(0, 0, 0, 0.04)',
  xl: '0 20px 25px rgba(0, 0, 0, 0.1), 0 10px 10px rgba(0, 0, 0, 0.04)',
  elevated: '0 4px 16px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04)',
  floating: '0 12px 28px rgba(0, 0, 0, 0.12), 0 8px 12px rgba(0, 0, 0, 0.08)',
} as const;

export type ShadowKey = keyof typeof SHADOWS;

// Dark mode shadow variants
export const SHADOWS_DARK = {
  none: 'none',
  subtle: '0 1px 2px rgba(0, 0, 0, 0.2)',
  sm: '0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2)',
  md: '0 4px 6px rgba(0, 0, 0, 0.25), 0 2px 4px rgba(0, 0, 0, 0.15)',
  lg: '0 10px 15px rgba(0, 0, 0, 0.3), 0 4px 6px rgba(0, 0, 0, 0.2)',
  xl: '0 20px 25px rgba(0, 0, 0, 0.4), 0 10px 10px rgba(0, 0, 0, 0.2)',
  elevated: '0 4px 16px rgba(0, 0, 0, 0.3), 0 2px 8px rgba(0, 0, 0, 0.2)',
  floating: '0 12px 28px rgba(0, 0, 0, 0.4), 0 8px 12px rgba(0, 0, 0, 0.3)',
} as const;

// ============================================================================
// Glass Effect Tokens
// ============================================================================

export const GLASS = {
  blur: {
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
  },
  surface: {
    light: {
      bg: 'rgba(255, 255, 255, 0.7)',
      border: 'rgba(0, 0, 0, 0.06)',
      shadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 0.8)',
    },
    dark: {
      bg: 'rgba(30, 30, 30, 0.6)',
      border: 'rgba(255, 255, 255, 0.08)',
      shadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
    },
  },
  panel: {
    light: {
      bg: 'rgba(255, 255, 255, 0.85)',
      border: 'rgba(0, 0, 0, 0.08)',
      shadow: '0 8px 32px rgba(0, 0, 0, 0.08)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 1)',
    },
    dark: {
      bg: 'rgba(20, 20, 20, 0.85)',
      border: 'rgba(255, 255, 255, 0.1)',
      shadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
    },
  },
  floating: {
    light: {
      bg: 'rgba(255, 255, 255, 0.92)',
      border: 'rgba(0, 0, 0, 0.1)',
      shadow: '0 12px 40px rgba(0, 0, 0, 0.12), 0 4px 12px rgba(0, 0, 0, 0.08)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 1)',
    },
    dark: {
      bg: 'rgba(25, 25, 25, 0.95)',
      border: 'rgba(255, 255, 255, 0.12)',
      shadow: '0 12px 40px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.4)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 0.1)',
    },
  },
} as const;

// ============================================================================
// Semantic Colors
// ============================================================================

export const SEMANTIC_COLORS = {
  like: {
    light: '#ef4444',
    dark: '#f87171',
  },
  badge: {
    light: '#f59e0b',
    dark: '#fbbf24',
  },
  streak: {
    light: '#f97316',
    dark: '#fb923c',
  },
  warning: {
    light: '#eab308',
    dark: '#facc15',
  },
  follow: {
    light: '#0095f6',
    dark: '#60a5fa',
  },
  info: {
    light: '#3b82f6',
    dark: '#60a5fa',
  },
  success: {
    light: '#22c55e',
    dark: '#4ade80',
  },
  error: {
    light: '#ef4444',
    dark: '#f87171',
  },
} as const;

export type SemanticColorKey = keyof typeof SEMANTIC_COLORS;

// ============================================================================
// Button Sizes
// ============================================================================

export const BUTTON_SIZES = {
  xs: {
    height: '1.75rem', // 28px
    paddingX: '0.5rem', // 8px
    fontSize: '0.75rem', // 12px
    iconSize: '0.875rem', // 14px
    radius: '8px',
  },
  sm: {
    height: '2rem', // 32px
    paddingX: '0.75rem', // 12px
    fontSize: '0.75rem', // 12px
    iconSize: '1rem', // 16px
    radius: '8px',
  },
  md: {
    height: '2.25rem', // 36px
    paddingX: '1rem', // 16px
    fontSize: '0.875rem', // 14px
    iconSize: '1.125rem', // 18px
    radius: '8px',
  },
  lg: {
    height: '2.75rem', // 44px
    paddingX: '1.5rem', // 24px
    fontSize: '1rem', // 16px
    iconSize: '1.25rem', // 20px
    radius: '8px',
  },
} as const;

export type ButtonSizeKey = keyof typeof BUTTON_SIZES;

// ============================================================================
// Transitions
// ============================================================================

export const TRANSITIONS = {
  fast: '150ms',
  normal: '200ms',
  slow: '300ms',
  slower: '400ms',
} as const;

export type TransitionKey = keyof typeof TRANSITIONS;

export const EASINGS = {
  default: 'cubic-bezier(0.4, 0, 0.2, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  out: 'cubic-bezier(0, 0, 0.2, 1)',
  inOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  bounce: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  spring: 'cubic-bezier(0.16, 1, 0.3, 1)',
} as const;

export type EasingKey = keyof typeof EASINGS;

// ============================================================================
// Z-Index Scale
// ============================================================================

export const Z_INDEX = {
  base: 0,
  dropdown: 100,
  sticky: 200,
  fixed: 300,
  modalBackdrop: 400,
  modal: 500,
  popover: 600,
  tooltip: 700,
  toast: 800,
  max: 9999,
} as const;

export type ZIndexKey = keyof typeof Z_INDEX;

// ============================================================================
// Breakpoints (for JS media query matching)
// ============================================================================

export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;

export type BreakpointKey = keyof typeof BREAKPOINTS;

// ============================================================================
// Utility Types
// ============================================================================

export type ThemeMode = 'light' | 'dark';

export interface TokenValue {
  light: string;
  dark: string;
}

// Helper to get themed value
export function getThemedValue<T extends Record<string, TokenValue>>(
  tokens: T,
  key: keyof T,
  theme: ThemeMode
): string {
  return tokens[key][theme];
}

// Helper to get CSS variable
export function cssVar(name: string, fallback?: string): string {
  return fallback ? `var(--${name}, ${fallback})` : `var(--${name})`;
}

// ============================================================================
// Component Variants
// ============================================================================

export const BUTTON_VARIANTS = [
  'primary',
  'secondary',
  'ghost',
  'outline',
  'danger',
  'glass',
] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

export const CARD_VARIANTS = ['default', 'glass', 'elevated'] as const;
export type CardVariant = (typeof CARD_VARIANTS)[number];

export const INPUT_VARIANTS = ['default', 'glass', 'filled'] as const;
export type InputVariant = (typeof INPUT_VARIANTS)[number];

// Export all tokens as a single object for convenience
const tokens = {
  SPACING,
  RADII,
  FONT_SIZE,
  LINE_HEIGHT,
  FONT_WEIGHT,
  SHADOWS,
  SHADOWS_DARK,
  GLASS,
  SEMANTIC_COLORS,
  BUTTON_SIZES,
  TRANSITIONS,
  EASINGS,
  Z_INDEX,
  BREAKPOINTS,
};

export default tokens;
