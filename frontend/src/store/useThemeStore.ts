/**
 * Theme Store
 *
 * Global theme state management.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { STORAGE_KEYS } from '../constants/storage';

type ThemePreference = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  isDark: boolean;
  toggleTheme: () => void;
  setTheme: (theme: ThemePreference) => void;
  initializeTheme: () => void;
}

const getSystemTheme = (): ResolvedTheme => {
  if (typeof window !== 'undefined') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return 'light';
};

const applyTheme = (resolvedTheme: ResolvedTheme) => {
  if (typeof document !== 'undefined') {
    if (resolvedTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
};

const resolveTheme = (theme: ThemePreference): ResolvedTheme => {
  if (theme === 'system') {
    return getSystemTheme();
  }
  return theme;
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      resolvedTheme: getSystemTheme(),
      isDark: getSystemTheme() === 'dark',

      toggleTheme: () => {
        const { theme, resolvedTheme } = get();
        let newTheme: ThemePreference;
        
        if (theme === 'light') {
          newTheme = 'dark';
        } else if (theme === 'dark') {
          newTheme = 'light';
        } else {
          // If system, toggle to opposite of current resolved theme
          newTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
        }

        const newResolved = resolveTheme(newTheme);
        applyTheme(newResolved);
        
        set({
          theme: newTheme,
          resolvedTheme: newResolved,
          isDark: newResolved === 'dark',
        });
      },

      setTheme: (theme) => {
        const newResolved = resolveTheme(theme);
        applyTheme(newResolved);
        
        set({
          theme,
          resolvedTheme: newResolved,
          isDark: newResolved === 'dark',
        });
      },

      initializeTheme: () => {
        const { theme } = get();
        const newResolved = resolveTheme(theme);
        applyTheme(newResolved);
        
        set({
          resolvedTheme: newResolved,
          isDark: newResolved === 'dark',
        });

        // Listen for system theme changes
        if (typeof window !== 'undefined') {
          const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
          mediaQuery.addEventListener('change', () => {
            const currentTheme = get().theme;
            if (currentTheme === 'system') {
              const systemTheme = getSystemTheme();
              applyTheme(systemTheme);
              set({
                resolvedTheme: systemTheme,
                isDark: systemTheme === 'dark',
              });
            }
          });
        }
      },
    }),
    {
      name: STORAGE_KEYS.THEME,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ theme: state.theme }),
      onRehydrateStorage: () => (state) => {
        // Apply theme on rehydration
        if (state) {
          state.initializeTheme();
        }
      },
    }
  )
);

/**
 * Helper hook to get current theme preference
 */
export const useThemePreference = () => {
  return useThemeStore((state) => state.theme);
};

/**
 * Helper hook to check if dark mode
 */
export const useIsDarkMode = () => {
  return useThemeStore((state) => state.isDark);
};

/**
 * Custom hook that provides the same API as the old ThemeContext
 * This makes migration easier - components can use useTheme() directly
 */
export const useTheme = () => {
  const theme = useThemeStore((state) => state.theme);
  const isDark = useThemeStore((state) => state.isDark);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const setTheme = useThemeStore((state) => state.setTheme);

  return {
    theme,
    isDark,
    toggleTheme,
    setTheme,
  };
};
