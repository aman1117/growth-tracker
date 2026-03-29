/**
 * BottomNavigation Component
 *
 * Instagram-style bottom navigation bar with icons for main navigation.
 * Features: Home, Add (customize tiles), Analytics, and Profile/Settings
 */

import { BarChart3, Home, Settings2, User as UserIcon } from 'lucide-react';
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import { useAuth } from '../store';
import styles from './BottomNavigation.module.css';
import { ProtectedImage } from './ui';

interface NavItemProps {
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  label: string;
  isProfile?: boolean;
  profilePic?: string | null;
  username?: string;
}

const NavItem: React.FC<NavItemProps> = ({
  icon,
  isActive,
  onClick,
  label,
  isProfile = false,
  profilePic,
  username,
}) => (
  <button
    onClick={onClick}
    className={`${styles.navItem} ${isActive ? styles.navItemActive : styles.navItemInactive}`}
    aria-label={label}
  >
    {isProfile ? (
      <div
        className={`${styles.profileRing} ${isActive ? styles.profileRingActive : styles.profileRingInactive}`}
      >
        <div className={styles.profileAvatar}>
          {profilePic ? (
            <ProtectedImage
              src={profilePic}
              alt={username || 'Profile'}
              className={styles.profileImage}
            />
          ) : (
            username?.charAt(0) || <UserIcon size={16} />
          )}
        </div>
      </div>
    ) : (
      <div className={`${styles.iconScale} ${isActive ? styles.iconScaleActive : ''}`}>{icon}</div>
    )}
  </button>
);

interface BottomNavigationProps {
  onCustomizeTiles?: () => void;
}

export const BottomNavigation: React.FC<BottomNavigationProps> = ({ onCustomizeTiles }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  if (!user) return null;

  const isHome =
    location.pathname === APP_ROUTES.HOME ||
    location.pathname === '/' ||
    location.pathname.startsWith('/user/');
  const isAnalytics =
    location.pathname === APP_ROUTES.ANALYTICS || location.pathname.startsWith('/analytics');
  const isSettings = location.pathname === APP_ROUTES.SETTINGS;

  return (
    <nav className={styles.nav}>
      <div className={styles.navInner}>
        {/* Home */}
        <NavItem
          icon={<Home size={26} strokeWidth={isHome && !isAnalytics && !isSettings ? 2 : 1.5} />}
          isActive={isHome && !isAnalytics && !isSettings}
          onClick={() => navigate(APP_ROUTES.HOME)}
          label="Home"
        />

        {/* Customize Tiles */}
        <NavItem
          icon={<Settings2 size={26} strokeWidth={1.5} />}
          isActive={false}
          onClick={() => {
            if (onCustomizeTiles) {
              onCustomizeTiles();
            } else {
              window.dispatchEvent(new CustomEvent('toggleEditMode'));
            }
          }}
          label="Customize"
        />

        {/* Analytics */}
        <NavItem
          icon={<BarChart3 size={26} strokeWidth={isAnalytics ? 2 : 1.5} />}
          isActive={isAnalytics}
          onClick={() => navigate(APP_ROUTES.ANALYTICS)}
          label="Analytics"
        />

        {/* Profile/Settings */}
        <NavItem
          icon={<UserIcon size={26} strokeWidth={isSettings ? 2 : 1.5} />}
          isActive={isSettings}
          onClick={() => navigate(APP_ROUTES.SETTINGS)}
          label="Profile"
          isProfile={true}
          profilePic={user.profilePicThumb || user.profilePic}
          username={user.username}
        />
      </div>
    </nav>
  );
};

export default BottomNavigation;
