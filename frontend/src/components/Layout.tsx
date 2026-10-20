import { Search } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { useBackDismiss } from '../hooks/useBackDismiss';
import { useNotificationNavigation } from '../hooks/useNotificationNavigation';
import { useOverlayAwareNavigate } from '../hooks/useOverlayAwareNavigate';
import { useAuth } from '../store';
import { useNotificationPreviewStore } from '../store/useNotificationPreviewStore';
import type { AutocompleteSuggestion } from '../types';
import {
  APP_NAME,
  isAuthFlowRoute,
  scrollToTop,
  TAB_RESELECT_EVENT,
  type TabReselectDetail,
} from '../utils/navigation';
import { BottomNavigation } from './BottomNavigation';
import styles from './Layout.module.css';
import { UserSearchAutocomplete } from './search';
import { ThemeToggle } from './ThemeToggle';
import { BrandLogo, NotificationCenter, NotificationPreviewToast } from './ui';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const overlayNavigate = useOverlayAwareNavigate();
  const location = useLocation();
  const { handleNotificationClick, handleUsernameClick } = useNotificationNavigation();

  // Notification preview state
  const preview = useNotificationPreviewStore((s) => s.preview);
  const dismissPreview = useNotificationPreviewStore((s) => s.dismissPreview);

  // Search is tied to the screen it was opened on, so any navigation closes it
  const [searchOpenOnKey, setSearchOpenOnKey] = useState<string | null>(null);
  const isSearchOpen = searchOpenOnKey === location.key;

  const openSearch = useCallback(() => {
    setSearchOpenOnKey(location.key);
  }, [location.key]);

  const closeSearch = useCallback(() => {
    setSearchOpenOnKey(null);
  }, []);

  // Back gesture closes the search overlay instead of leaving the page
  useBackDismiss(isSearchOpen, closeSearch);

  const handleSearchSelect = useCallback(
    (suggestion: AutocompleteSuggestion) => {
      const target = APP_ROUTES.USER_PROFILE(suggestion.text);
      // Re-selecting the profile you are on must not stack a duplicate history entry
      overlayNavigate(target, location.pathname === target ? { replace: true } : undefined);
      closeSearch();
    },
    [closeSearch, location.pathname, overlayNavigate]
  );

  const handleLogoClick = useCallback(() => {
    // Live URL (not React's location) so taps during a pending transition still navigate
    if (window.location.pathname === APP_ROUTES.HOME && !window.location.search) {
      scrollToTop();
      window.dispatchEvent(
        new CustomEvent<TabReselectDetail>(TAB_RESELECT_EVENT, { detail: { tab: 'home' } })
      );
      return;
    }
    overlayNavigate(APP_ROUTES.HOME);
  }, [overlayNavigate]);

  // Auth flow pages - minimal layout: just the wordmark (no navigation) so email-link
  // landings still feel branded without offering exits mid-flow
  if (isAuthFlowRoute(location.pathname)) {
    return (
      <div className={styles.wrapper}>
        <div className={styles.brandBar}>
          <BrandLogo />
        </div>
        <main id="main-content" className={`${styles.main} ${styles.mainNoNav}`}>
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          {/* Logo - Left side */}
          {!isSearchOpen && (
            <button
              type="button"
              className={styles.logo}
              onClick={handleLogoClick}
              aria-label={`${APP_NAME} home`}
            >
              <BrandLogo label="" />
            </button>
          )}

          {/* Right side icons */}
          {user && (
            <div
              className={`${styles.rightIcons} ${isSearchOpen ? styles.rightIconsExpanded : ''}`}
            >
              {/* Search - icon button when closed, full autocomplete when open */}
              {!isSearchOpen ? (
                <button
                  type="button"
                  onClick={openSearch}
                  className={styles.iconButton}
                  aria-label="Search users"
                >
                  <Search size={20} strokeWidth={2} aria-hidden="true" />
                </button>
              ) : (
                <div className={styles.searchExpanded}>
                  <UserSearchAutocomplete
                    placeholder="Search users..."
                    onSelect={handleSearchSelect}
                    navigateOnSelect={false}
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
      {isSearchOpen && <div onClick={closeSearch} className={styles.backdrop} aria-hidden="true" />}

      <main
        id="main-content"
        className={`${styles.main} ${user ? styles.mainWithNav : styles.mainNoNav}`}
      >
        {children}
      </main>

      {/* Bottom tab bar - always available once signed in so no screen is a dead end */}
      {user && <BottomNavigation />}

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
