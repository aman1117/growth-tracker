import { Search } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { useAuth } from '../store';
import type { AutocompleteSuggestion, LikeMetadata, Notification } from '../types';
import { BottomNavigation } from './BottomNavigation';
import { UserSearchAutocomplete } from './search';
import { ThemeToggle } from './ThemeToggle';
import { NotificationCenter } from './ui';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const navigate = useNavigate();

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

  // Type guard to check if metadata is LikeMetadata
  const isLikeMetadata = (metadata: unknown): metadata is LikeMetadata => {
    return (
      metadata !== null &&
      typeof metadata === 'object' &&
      'liker_username' in metadata &&
      'liked_date' in metadata
    );
  };

  // Type guard for day completed metadata
  const isDayCompletedMetadata = (
    metadata: unknown
  ): metadata is { completed_username: string; completed_date: string } => {
    return (
      typeof metadata === 'object' &&
      metadata !== null &&
      'completed_username' in metadata &&
      'completed_date' in metadata
    );
  };

  // Handle notification card click - navigate based on notification type
  const handleNotificationClick = useCallback(
    (notification: Notification) => {
      const metadata = notification.metadata as Record<string, unknown> | undefined;

      if (notification.type === 'like_received' && isLikeMetadata(notification.metadata)) {
        // Navigate to home with the liked date as a query parameter
        navigate(`${APP_ROUTES.HOME}?date=${notification.metadata.liked_date}`);
      } else if (
        notification.type === 'streak_milestone' &&
        isDayCompletedMetadata(notification.metadata)
      ) {
        // Navigate to the completed user's profile with the date
        navigate(
          `${APP_ROUTES.USER_PROFILE(notification.metadata.completed_username)}?date=${notification.metadata.completed_date}`
        );
      } else if (
        (notification.type === 'new_follower' ||
          notification.type === 'follow_request' ||
          notification.type === 'follow_accepted') &&
        metadata?.actor_username
      ) {
        // Navigate to the actor's profile for follow notifications
        navigate(APP_ROUTES.USER_PROFILE(metadata.actor_username as string));
      }
    },
    [navigate]
  );

  // Handle username click - navigate to user profile
  const handleUsernameClick = useCallback(
    (username: string) => {
      navigate(APP_ROUTES.USER_PROFILE(username));
    },
    [navigate]
  );

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
    </div>
  );
};
