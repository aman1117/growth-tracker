import React, { createContext, useContext, useState, useEffect } from 'react';

type ThemePreference = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

interface ThemeContextType {
    theme: ThemePreference;
    setTheme: (theme: ThemePreference) => void;
    toggleTheme: () => void;
    isDark: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const getSystemTheme = (): ResolvedTheme => {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [theme, setThemeState] = useState<ThemePreference>(() => {
        const stored = localStorage.getItem('growth-tracker-theme') as ThemePreference;
        if (stored && ['light', 'dark', 'system'].includes(stored)) return stored;
        return 'system';
    });

    const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
        const stored = localStorage.getItem('growth-tracker-theme') as ThemePreference;
        if (stored === 'light') return 'light';
        if (stored === 'dark') return 'dark';
        return getSystemTheme();
    });

    // Apply theme to DOM
    useEffect(() => {
        const root = document.documentElement;
        
        let effectiveTheme: ResolvedTheme;
        if (theme === 'system') {
            effectiveTheme = getSystemTheme();
        } else {
            effectiveTheme = theme;
        }
        
        setResolvedTheme(effectiveTheme);
        
        if (effectiveTheme === 'dark') {
            root.setAttribute('data-theme', 'dark');
        } else {
            root.removeAttribute('data-theme');
        }
        
        localStorage.setItem('growth-tracker-theme', theme);
    }, [theme]);

    // Listen for system theme changes
    useEffect(() => {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        
        const handleChange = () => {
            if (theme === 'system') {
                const systemTheme = getSystemTheme();
                setResolvedTheme(systemTheme);
                const root = document.documentElement;
                if (systemTheme === 'dark') {
                    root.setAttribute('data-theme', 'dark');
                } else {
                    root.removeAttribute('data-theme');
                }
            }
        };

        mediaQuery.addEventListener('change', handleChange);
        return () => mediaQuery.removeEventListener('change', handleChange);
    }, [theme]);

    const setTheme = (newTheme: ThemePreference) => {
        setThemeState(newTheme);
    };

    const toggleTheme = () => {
        setThemeState(prev => {
            if (prev === 'light') return 'dark';
            if (prev === 'dark') return 'light';
            // If system, toggle to opposite of current resolved theme
            return resolvedTheme === 'dark' ? 'light' : 'dark';
        });
    };

    return (
        <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, isDark: resolvedTheme === 'dark' }}>
            {children}
        </ThemeContext.Provider>
    );
};

export const useTheme = (): ThemeContextType => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};
