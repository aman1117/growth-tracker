import { Search } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { useNotificationNavigation } from '../hooks/useNotificationNavigation';
import { useAuth } from '../store';
import { useNotificationPreviewStore } from '../store/useNotificationPreviewStore';
import type { AutocompleteSuggestion } from '../types';
import { BottomNavigation } from './BottomNavigation';
import styles from './Layout.module.css';
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
      <div className={styles.wrapper}>
        <main className={`${styles.main} ${styles.mainNoNav}`}>{children}</main>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          {/* Logo - Left side */}
          {!isSearchOpen && (
            <div className={styles.logo} onClick={() => navigate(APP_ROUTES.HOME)}>
              <img src="/logo.png" alt="Growth Tracker" className={styles.logoImage} />
            </div>
          )}

          {/* Right side icons */}
          {user && (
            <div
              className={`${styles.rightIcons} ${isSearchOpen ? styles.rightIconsExpanded : ''}`}
            >
              {/* Search - icon button when closed, full autocomplete when open */}
              {!isSearchOpen ? (
                <button
                  onClick={() => setIsSearchOpen(true)}
                  className={styles.searchButton}
                  aria-label="Open search"
                >
                  <Search size={22} strokeWidth={1.8} />
                </button>
              ) : (
                <div className={styles.searchExpanded}>
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
      {isSearchOpen && <div onClick={closeSearch} className={styles.backdrop} />}

      <main
        className={`${styles.main} ${user && !isSettingsPage ? styles.mainWithNav : styles.mainNoNav}`}
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
