import { Moon, Sun, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

export function Header() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('help-theme');
      if (saved === 'dark' || saved === 'light') return saved;
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  });

  // Track whether this is the initial mount (skip transition on first paint)
  const hasMounted = useRef(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('help-theme', theme);
    hasMounted.current = true;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return (
    <header className="help-header">
      <div className="help-header-inner">
        <div className="help-header-brand">
          <div className="help-header-logo" style={{ background: '#eab308' }}>
            <TrendingUp size={18} color="#422006" />
          </div>
          <div>
            <div className="help-header-title">Growth Tracker</div>
            <div className="help-header-subtitle">Help Center</div>
          </div>
        </div>
        <button
          className="help-theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          type="button"
        >
          <span
            key={theme}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              animation: hasMounted.current ? 'themeIconIn 300ms cubic-bezier(0.16, 1, 0.3, 1)' : 'none',
            }}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </span>
        </button>
      </div>
    </header>
  );
}
