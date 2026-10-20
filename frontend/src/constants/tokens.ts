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
  xs: '6px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  '2xl': '24px',
  '3xl': '28px',
  full: '9999px',
  card: '24px',
  tile: '22px',
  control: '14px',
} as const;

export type RadiiKey = keyof typeof RADII;

// ============================================================================
// Brand ("Aurora" design language)
// ============================================================================

export const FONTS = {
  sans: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  display: "'Bricolage Grotesque', 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif",
} as const;

export const BRAND = {
  violet: {
    300: '#b4a5ff',
    400: '#9a85ff',
    500: '#7a61ff',
    600: '#6447f2',
    700: '#5236d4',
    800: '#4126b8',
  },
  canvas: { light: '#f6f5fb', dark: '#0b0a12' },
  gradient: {
    brand: {
      light: 'linear-gradient(118deg, #16a34a 0%, #0d9488 40%, #6447f2 100%)',
      dark: 'linear-gradient(118deg, #a3e635 0%, #2dd4bf 42%, #a78bfa 100%)',
    },
    progress: {
      light: 'linear-gradient(90deg, #22c55e 0%, #14b8a6 45%, #6447f2 100%)',
      dark: 'linear-gradient(90deg, #a3e635 0%, #2dd4bf 45%, #8b74ff 100%)',
    },
  },
} as const;

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
  extrabold: 800,
} as const;

export type FontWeightKey = keyof typeof FONT_WEIGHT;

// ============================================================================
// Shadows (violet-tinted in light mode)
// ============================================================================

export const SHADOWS = {
  none: 'none',
  subtle: '0 1px 2px rgba(23, 20, 44, 0.05)',
  sm: '0 1px 2px rgba(23, 20, 44, 0.06), 0 2px 6px -2px rgba(76, 58, 160, 0.1)',
  md: '0 4px 12px -2px rgba(76, 58, 160, 0.14), 0 2px 4px rgba(23, 20, 44, 0.05)',
  lg: '0 14px 30px -10px rgba(76, 58, 160, 0.22), 0 4px 8px rgba(23, 20, 44, 0.05)',
  xl: '0 24px 50px -16px rgba(52, 36, 128, 0.3), 0 6px 12px rgba(23, 20, 44, 0.06)',
  elevated: '0 8px 24px -8px rgba(76, 58, 160, 0.2), 0 2px 6px rgba(23, 20, 44, 0.05)',
  floating: '0 20px 44px -12px rgba(52, 36, 128, 0.32), 0 6px 14px rgba(23, 20, 44, 0.08)',
} as const;

export type ShadowKey = keyof typeof SHADOWS;

// Dark mode shadow variants
export const SHADOWS_DARK = {
  none: 'none',
  subtle: '0 1px 2px rgba(0, 0, 0, 0.3)',
  sm: '0 1px 2px rgba(0, 0, 0, 0.35), 0 2px 6px -2px rgba(0, 0, 0, 0.4)',
  md: '0 6px 14px -4px rgba(0, 0, 0, 0.5), 0 2px 4px rgba(0, 0, 0, 0.3)',
  lg: '0 16px 32px -12px rgba(0, 0, 0, 0.65), 0 4px 8px rgba(0, 0, 0, 0.3)',
  xl: '0 26px 54px -16px rgba(0, 0, 0, 0.75), 0 6px 12px rgba(0, 0, 0, 0.35)',
  elevated: '0 10px 28px -10px rgba(0, 0, 0, 0.65), 0 2px 6px rgba(0, 0, 0, 0.3)',
  floating: '0 22px 48px -12px rgba(0, 0, 0, 0.75), 0 6px 14px rgba(0, 0, 0, 0.4)',
} as const;

// ============================================================================
// Glass Effect Tokens
// ============================================================================

export const GLASS = {
  blur: {
    sm: '10px',
    md: '16px',
    lg: '22px',
    xl: '28px',
  },
  surface: {
    light: {
      bg: 'rgba(255, 255, 255, 0.72)',
      border: 'rgba(23, 20, 44, 0.07)',
      shadow: '0 1px 2px rgba(23, 20, 44, 0.04), 0 10px 30px -14px rgba(76, 58, 160, 0.2)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 0.9)',
    },
    dark: {
      bg: 'rgba(26, 24, 38, 0.66)',
      border: 'rgba(255, 255, 255, 0.07)',
      shadow: '0 1px 2px rgba(0, 0, 0, 0.3), 0 14px 32px -16px rgba(0, 0, 0, 0.7)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
    },
  },
  panel: {
    light: {
      bg: 'rgba(255, 255, 255, 0.9)',
      border: 'rgba(23, 20, 44, 0.08)',
      shadow: '0 28px 60px -20px rgba(52, 36, 128, 0.32), 0 2px 6px rgba(23, 20, 44, 0.06)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 1)',
    },
    dark: {
      bg: 'rgba(22, 20, 33, 0.94)',
      border: 'rgba(255, 255, 255, 0.09)',
      shadow: '0 30px 70px -20px rgba(0, 0, 0, 0.85)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 0.07)',
    },
  },
  floating: {
    light: {
      bg: 'rgba(255, 255, 255, 0.92)',
      border: 'rgba(23, 20, 44, 0.09)',
      shadow: '0 18px 44px -12px rgba(52, 36, 128, 0.3), 0 4px 12px rgba(23, 20, 44, 0.08)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 1)',
    },
    dark: {
      bg: 'rgba(29, 27, 42, 0.96)',
      border: 'rgba(255, 255, 255, 0.1)',
      shadow: '0 20px 50px -12px rgba(0, 0, 0, 0.8), 0 4px 12px rgba(0, 0, 0, 0.45)',
      glow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
    },
  },
} as const;

// ============================================================================
// Semantic Colors
// ============================================================================

export const SEMANTIC_COLORS = {
  like: {
    light: '#f43f5e',
    dark: '#fb7185',
  },
  badge: {
    light: '#6447f2',
    dark: '#9a85ff',
  },
  streak: {
    light: '#f97316',
    dark: '#fb923c',
  },
  warning: {
    light: '#f59e0b',
    dark: '#fbbf24',
  },
  follow: {
    light: '#6447f2',
    dark: '#9a85ff',
  },
  info: {
    light: '#2563eb',
    dark: '#60a5fa',
  },
  success: {
    light: '#16a34a',
    dark: '#4ade80',
  },
  error: {
    light: '#cc2b37',
    dark: '#ff6b72',
  },
} as const;

export type SemanticColorKey = keyof typeof SEMANTIC_COLORS;

// ============================================================================
// Button Sizes
// ============================================================================

export const BUTTON_SIZES = {
  xs: {
    height: '1.75rem', // 28px
    paddingX: '0.625rem', // 10px
    fontSize: '0.75rem', // 12px
    iconSize: '0.875rem', // 14px
    radius: '10px',
  },
  sm: {
    height: '2.125rem', // 34px
    paddingX: '0.875rem', // 14px
    fontSize: '0.8125rem', // 13px
    iconSize: '1rem', // 16px
    radius: '12px',
  },
  md: {
    height: '2.5rem', // 40px
    paddingX: '1.125rem', // 18px
    fontSize: '0.875rem', // 14px
    iconSize: '1.125rem', // 18px
    radius: '14px',
  },
  lg: {
    height: '3rem', // 48px
    paddingX: '1.5rem', // 24px
    fontSize: '1rem', // 16px
    iconSize: '1.25rem', // 20px
    radius: '16px',
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
// Semantic Typography Roles
// ============================================================================

export const TYPOGRAPHY_ROLES = {
  display: { size: '2.25rem', weight: 700, lineHeight: 1.25, letterSpacing: '-0.04em' },
  pageTitle: { size: '1.875rem', weight: 700, lineHeight: 1.25, letterSpacing: '-0.02em' },
  sectionTitle: { size: '1.25rem', weight: 700, lineHeight: 1.375, letterSpacing: '-0.02em' },
  cardTitle: { size: '1rem', weight: 700, lineHeight: 1.375, letterSpacing: '-0.01em' },
  titleSm: { size: '0.875rem', weight: 600, lineHeight: 1.375, letterSpacing: '-0.01em' },
  bodyLg: { size: '1rem', weight: 400, lineHeight: 1.625, letterSpacing: '0' },
  body: { size: '0.875rem', weight: 400, lineHeight: 1.5, letterSpacing: '0' },
  bodySm: { size: '0.8125rem', weight: 400, lineHeight: 1.5, letterSpacing: '0' },
  label: { size: '0.75rem', weight: 600, lineHeight: 1.25, letterSpacing: '0.01em' },
  labelSm: { size: '0.625rem', weight: 700, lineHeight: 1.25, letterSpacing: '0.05em' },
  caption: { size: '0.75rem', weight: 500, lineHeight: 1.375, letterSpacing: '0' },
  button: { size: '0.875rem', weight: 700, lineHeight: 1, letterSpacing: '-0.005em' },
  buttonSm: { size: '0.75rem', weight: 700, lineHeight: 1, letterSpacing: '0' },
  overline: { size: '0.625rem', weight: 700, lineHeight: 1, letterSpacing: '0.08em' },
} as const;

export type TypographyRoleKey = keyof typeof TYPOGRAPHY_ROLES;

// ============================================================================
// Semantic Text Colors
// ============================================================================

export const TEXT_COLORS = {
  primary: 'var(--color-text-primary)',
  secondary: 'var(--color-text-secondary)',
  tertiary: 'var(--color-text-tertiary)',
  muted: 'var(--color-text-muted)',
  inverse: 'var(--color-text-inverse)',
  disabled: 'var(--color-text-disabled)',
  link: 'var(--color-text-link)',
  success: 'var(--color-text-success)',
  warning: 'var(--color-text-warning)',
  danger: 'var(--color-text-danger)',
  info: 'var(--color-text-info)',
} as const;

export type TextColorKey = keyof typeof TEXT_COLORS;

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
  FONTS,
  BRAND,
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
