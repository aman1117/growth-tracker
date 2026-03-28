import { Search } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { useNotificationNavigation } from '../hooks/useNotificationNavigation';
import { useAuth } from '../store';
import { useNotificationPreviewStore } from '../store/useNotificationPreviewStore';
import type { AutocompleteSuggestion } from '../types';
import { BottomNavigation } from './BottomNavigation';
import { UserSearchAutocomplete } from './search';
import { ThemeToggle } from './ThemeToggle';
import { NotificationCenter, NotificationPreviewToast } from './ui';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { handleNotificationClick, handleUsernameClick } = useNotificationNavigation();

  // Notification preview state
  const preview = useNotificationPreviewStore((s) => s.preview);
  const dismissPreview = useNotificationPreviewStore((s) => s.dismissPreview);

  // Search State - simplified with new component
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const handleSearchSelect = useCallback(
    (suggestion: AutocompleteSuggestion) => {
      navigate(APP_ROUTES.USER_PROFILE(suggestion.text));
      setIsSearchOpen(false);
    },
    [navigate]
  );

  const closeSearch = () => {
    setIsSearchOpen(false);
  };

  const location = useLocation();
  const isSettingsPage = location.pathname === APP_ROUTES.SETTINGS;

  // Auth flow pages - hide header and footer navigation
  const isAuthFlowPage = [
    APP_ROUTES.FORGOT_PASSWORD,
    APP_ROUTES.RESET_PASSWORD,
    APP_ROUTES.VERIFY_EMAIL,
  ].includes(location.pathname as typeof APP_ROUTES.FORGOT_PASSWORD);

  // For auth flow pages, render minimal layout without header/footer
  if (isAuthFlowPage) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <main style={{ flex: 1, paddingTop: '0.5rem', paddingBottom: '0.5rem' }}>{children}</main>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          borderBottom: '1px solid var(--border)',
          padding: '0.75rem 0',
          backgroundColor: 'var(--header-bg)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          position: 'sticky',
          top: 0,
          zIndex: 50,
          transition: 'background-color 0.3s ease, border-color 0.3s ease',
        }}
      >
        <div
          className="container"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0 1rem',
            maxWidth: '560px',
            margin: '0 auto',
          }}
        >
          {/* Logo - Left side */}
          {!isSearchOpen && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onClick={() => navigate(APP_ROUTES.HOME)}
            >
              <img
                src="/logo.png"
                alt="Growth Tracker"
                style={{
                  height: '28px',
                  width: 'auto',
                  filter: 'var(--logo-filter)',
                }}
              />
            </div>
          )}

          {/* Right side icons */}
          {user && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                flex: isSearchOpen ? 1 : 'unset',
                marginLeft: isSearchOpen ? '0' : 'auto',
                position: 'relative',
                justifyContent: 'flex-end',
                transition: 'margin-left 0.3s ease',
              }}
            >
              {/* Search - icon button when closed, full autocomplete when open */}
              {!isSearchOpen ? (
                <button
                  onClick={() => setIsSearchOpen(true)}
                  style={{
                    width: '40px',
                    height: '40px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: '50%',
                    cursor: 'pointer',
                    color: 'var(--text-primary)',
                  }}
                  aria-label="Open search"
                >
                  <Search size={22} strokeWidth={1.8} />
                </button>
              ) : (
                <div style={{ flex: 1 }}>
                  <UserSearchAutocomplete
                    placeholder="Search users..."
                    onSelect={handleSearchSelect}
                    onComplete={closeSearch}
                    onBlur={closeSearch}
                    autoFocus
                  />
                </div>
              )}

              {/* Notifications - hide when search is open */}
              {!isSearchOpen && (
                <NotificationCenter
                  onNotificationClick={handleNotificationClick}
                  onUsernameClick={handleUsernameClick}
                />
              )}
            </div>
          )}

          {/* Show theme toggle when not logged in */}
          {!user && <ThemeToggle />}
        </div>
      </header>

      {/* Backdrop blur when search is open */}
      {isSearchOpen && (
        <div
          onClick={closeSearch}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.4)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            zIndex: 40,
            animation: 'fadeIn 0.2s ease-out',
          }}
        />
      )}
      <style>{`
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
            `}</style>

      <main
        style={{
          flex: 1,
          paddingTop: '0.5rem',
          paddingBottom: user && !isSettingsPage ? '80px' : '0.5rem',
        }}
      >
        {children}
      </main>

      {/* Bottom Navigation - only show for logged in users and not on settings page */}
      {user && !isSettingsPage && <BottomNavigation />}

      {/* Notification Preview Toast */}
      {preview && (
        <NotificationPreviewToast
          key={preview.id}
          notification={preview}
          onClose={dismissPreview}
          onClick={handleNotificationClick}
        />
      )}
    </div>
  );
};
