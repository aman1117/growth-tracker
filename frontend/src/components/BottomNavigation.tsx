/**
 * BottomNavigation Component
 *
 * Primary navigation: Home, Customize (action), Analytics and Profile.
 * Renders as a floating glass dock on phones/tablets and as a vertical side
 * rail on desktop (≥1024px) — same markup, layout switched in CSS.
 *
 * Behaviour (mirrors native tab bars):
 * - Tapping a tab opens that tab's root screen.
 * - Tapping the tab you are already on scrolls to the top and emits a
 *   "tab reselect" event so the screen can reset (e.g. Home jumps to today).
 * - Screens that belong to another user highlight no tab.
 * - Customize works from any screen: it opens Home and enters edit mode there.
 */

import { BarChart3, Blocks, Home, User as UserIcon } from 'lucide-react';
import React, { useCallback } from 'react';
import { useLocation } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { useOverlayAwareNavigate } from '../hooks/useOverlayAwareNavigate';
import { gl } from '../services/goodlogs';
import { useAuth } from '../store';
import {
  type AppTab,
  getActiveTab,
  getProfileUsername,
  type HomeNavigationState,
  scrollToTop,
  TAB_RESELECT_EVENT,
  TAB_ROUTES,
  type TabReselectDetail,
} from '../utils/navigation';
import styles from './BottomNavigation.module.css';
import { ProtectedImage } from './ui';

const ICON_SIZE = 22;
const ACTIVE_STROKE = 2.4;
const INACTIVE_STROKE = 1.9;

interface NavItemProps {
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  /** Accessible name */
  label: string;
  /** Short visible caption */
  caption: string;
  isProfile?: boolean;
  profilePic?: string | null;
  username?: string;
}

const NavItem: React.FC<NavItemProps> = ({
  icon,
  isActive,
  onClick,
  label,
  caption,
  isProfile = false,
  profilePic,
  username,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
    aria-label={label}
    aria-current={isActive ? 'page' : undefined}
  >
    {isProfile ? (
      <span
        className={`${styles.profileRing} ${isActive ? styles.profileRingActive : ''}`}
        aria-hidden="true"
      >
        <span className={styles.profileAvatar}>
          {profilePic ? (
            <ProtectedImage src={profilePic} alt="" className={styles.profileImage} />
          ) : (
            username?.charAt(0) || <UserIcon size={14} />
          )}
        </span>
      </span>
    ) : (
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
    )}
    <span className={styles.caption} aria-hidden="true">
      {caption}
    </span>
  </button>
);

interface BottomNavigationProps {
  onCustomizeTiles?: () => void;
}

export const BottomNavigation: React.FC<BottomNavigationProps> = ({ onCustomizeTiles }) => {
  // Overlay-aware: tapping a tab while e.g. search is open replaces the overlay's entry
  const navigate = useOverlayAwareNavigate();
  const location = useLocation();
  const { user } = useAuth();

  const activeTab = getActiveTab(location.pathname, location.search, user?.username);

  const handleTabPress = useCallback(
    (tab: AppTab) => {
      const root = TAB_ROUTES[tab];
      // Read the live URL: during a pending (lazy-loading) transition React's location
      // still points at the previous screen, and a quick second tap must not be ignored.
      const { pathname, search } = window.location;
      const currentTab = getActiveTab(pathname, search, user?.username);
      const isOnRoot = pathname === root && !search;

      if (currentTab === tab && isOnRoot) {
        scrollToTop();
        window.dispatchEvent(
          new CustomEvent<TabReselectDetail>(TAB_RESELECT_EVENT, { detail: { tab } })
        );
        gl.debug('tab_reselected', { metadata: { tab } });
        return;
      }

      gl.debug('tab_selected', { metadata: { tab, from: currentTab ?? 'none' } });
      navigate(root);
    },
    [navigate, user?.username]
  );

  const handleCustomize = useCallback(() => {
    if (onCustomizeTiles) {
      onCustomizeTiles();
      return;
    }

    const { pathname } = window.location;
    const profileUsername = getProfileUsername(pathname);
    const isOnOwnDashboard =
      pathname === APP_ROUTES.HOME ||
      (!!profileUsername && profileUsername.toLowerCase() === user?.username.toLowerCase());

    if (isOnOwnDashboard) {
      window.dispatchEvent(new CustomEvent('toggleEditMode'));
      return;
    }

    // The tile grid lives on Home — open it and enter edit mode once it is ready
    const state: HomeNavigationState = { enterEditMode: true };
    gl.debug('customize_from_other_screen', { metadata: { tab: activeTab ?? 'none' } });
    navigate(APP_ROUTES.HOME, { state });
  }, [activeTab, navigate, onCustomizeTiles, user?.username]);

  if (!user) return null;

  const isHome = activeTab === 'home';
  const isAnalytics = activeTab === 'analytics';
  const isProfile = activeTab === 'profile';

  return (
    <nav className={styles.nav} aria-label="Primary">
      <div className={styles.navInner}>
        <NavItem
          icon={<Home size={ICON_SIZE} strokeWidth={isHome ? ACTIVE_STROKE : INACTIVE_STROKE} />}
          isActive={isHome}
          onClick={() => handleTabPress('home')}
          label="Home"
          caption="Home"
        />

        <NavItem
          icon={<Blocks size={ICON_SIZE} strokeWidth={INACTIVE_STROKE} />}
          isActive={false}
          onClick={handleCustomize}
          label="Customize tiles"
          caption="Customize"
        />

        <NavItem
          icon={
            <BarChart3
              size={ICON_SIZE}
              strokeWidth={isAnalytics ? ACTIVE_STROKE : INACTIVE_STROKE}
            />
          }
          isActive={isAnalytics}
          onClick={() => handleTabPress('analytics')}
          label="Insights"
          caption="Insights"
        />

        <NavItem
          icon={<UserIcon size={ICON_SIZE} />}
          isActive={isProfile}
          onClick={() => handleTabPress('profile')}
          label="You: profile and settings"
          caption="You"
          isProfile
          profilePic={user.profilePicThumb || user.profilePic}
          username={user.username}
        />
      </div>
    </nav>
  );
};

export default BottomNavigation;
