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
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.25rem',
      padding: '0.5rem 1rem',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
      transition: 'all 0.2s ease',
      minWidth: '64px',
    }}
    aria-label={label}
  >
    {isProfile ? (
      <div
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          border: isActive ? '2px solid var(--text-primary)' : '2px solid transparent',
          padding: '1px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'border-color 0.2s ease',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            backgroundColor: 'var(--avatar-bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            fontSize: '0.75rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            color: 'var(--text-primary)',
          }}
        >
          {profilePic ? (
            <ProtectedImage
              src={profilePic}
              alt={username || 'Profile'}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
          ) : (
            username?.charAt(0) || <UserIcon size={16} />
          )}
        </div>
      </div>
    ) : (
      <div
        style={{
          transform: isActive ? 'scale(1.1)' : 'scale(1)',
          transition: 'transform 0.2s ease',
        }}
      >
        {icon}
      </div>
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
    <nav
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: 'var(--header-bg)',
        backdropFilter: 'blur(var(--tile-glass-blur, 20px))',
        WebkitBackdropFilter: 'blur(var(--tile-glass-blur, 20px))',
        borderTop: '1px solid var(--border)',
        zIndex: 50,
        display: 'flex',
        justifyContent: 'center',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-around',
          alignItems: 'center',
          width: '100%',
          maxWidth: '560px',
          padding: '0.5rem 1rem',
        }}
      >
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
          profilePic={user.profilePic}
          username={user.username}
        />
      </div>
    </nav>
  );
};

export default BottomNavigation;
