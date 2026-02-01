/**
 * SettingsPage Component (Modular Version)
 *
 * Main settings page that composes modular components.
 * Handles profile management, account settings, privacy, and notifications.
 */

import {
  ArrowLeft,
  ChevronRight,
  Key,
  Lock,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Sun,
  User,
  UserPlus,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import { VALIDATION, VALIDATION_MESSAGES } from '../../constants/validation';
import { api } from '../../services/api';
import { useAuth, useFollowStore, usePendingRequestsCount, useTheme } from '../../store';
import type { Badge } from '../../types/api';
import { BadgeShowcase } from '../BadgeShowcase';
import { FollowListModal, FollowRequestsModal } from '../social';
import { SnapToast } from '../ui';

import {
  BioDialog,
  FullscreenProfilePic,
  LogoutDialog,
  PasswordDialog,
  ProfilePictureDialog,
  ProfileSection,
  PushNotificationsSection,
  SettingsItem,
  UsernameDialog,
} from './components';
import type { ToastData } from './SettingsPage.types';

export const SettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout, updateUsername, updateProfilePic, updateBio } = useAuth();
  const { theme, setTheme } = useTheme();
  const { getIncomingRequests, getCounts } = useFollowStore();
  const pendingRequestsCount = usePendingRequestsCount();

  // Dialog states
  const [showUsernameDialog, setShowUsernameDialog] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [showLogoutDialog, setShowLogoutDialog] = useState(false);
  const [showFullscreenPic, setShowFullscreenPic] = useState(false);
  const [showPicDialog, setShowPicDialog] = useState(false);
  const [showBioDialog, setShowBioDialog] = useState(false);
  const [showFollowRequestsModal, setShowFollowRequestsModal] = useState(false);
  const [showFollowListModal, setShowFollowListModal] = useState<'followers' | 'following' | null>(
    null
  );

  // Follow counts
  const [followersCount, setFollowersCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);

  // Profile picture state
  const [isUploadingPic, setIsUploadingPic] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Privacy state
  const [isPrivate, setIsPrivate] = useState(false);
  const [isPrivacyLoading, setIsPrivacyLoading] = useState(false);

  // Badges state
  const [badges, setBadges] = useState<Badge[]>([]);
  const [longestStreak, setLongestStreak] = useState(0);
  const [badgesLoading, setBadgesLoading] = useState(true);

  // Toast
  const [toast, setToast] = useState<ToastData | null>(null);

  // Page animation
  const [isExiting, setIsExiting] = useState(false);

  // Fetch all data on mount
  useEffect(() => {
    if (user) {
      // Fetch privacy setting
      api.get('/get-privacy').then((res) => {
        if (res.success) {
          setIsPrivate(res.is_private);
        }
      });

      // Fetch profile data
      api.get('/profile').then((res) => {
        if (res.success) {
          if (res.profile_pic) {
            updateProfilePic(res.profile_pic);
          }
          if (res.bio !== undefined) {
            updateBio(res.bio);
          }
        }
      });

      // Fetch badges
      api
        .get('/badges')
        .then((res) => {
          if (res.success && res.badges) {
            setBadges(res.badges);
          }
        })
        .finally(() => setBadgesLoading(false));

      // Fetch streak for longest
      const today = new Date().toISOString().split('T')[0];
      api.post('/get-streak', { username: user.username, date: today }).then((res) => {
        if (res.success && res.data) {
          setLongestStreak(res.data.longest);
        }
      });

      // Fetch pending follow requests count
      getIncomingRequests(undefined, 1);

      // Fetch follow counts
      getCounts(user.id).then((counts) => {
        if (counts) {
          setFollowersCount(counts.followers);
          setFollowingCount(counts.following);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!user) {
    navigate(APP_ROUTES.LOGIN);
    return null;
  }

  const togglePrivacy = async () => {
    setIsPrivacyLoading(true);
    try {
      const res = await api.post('/update-privacy', { is_private: !isPrivate });
      if (res.success) {
        setIsPrivate(res.is_private);
      }
    } catch {
      console.error('Failed to update privacy');
    } finally {
      setIsPrivacyLoading(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.toLowerCase().split('.').pop();

    if (
      !VALIDATION.ALLOWED_IMAGE_TYPES.includes(file.type) &&
      !VALIDATION.ALLOWED_IMAGE_EXTENSIONS.includes(ext || '')
    ) {
      setToast({ message: VALIDATION_MESSAGES.FILE_TYPE_ERROR, type: 'error' });
      return;
    }

    if (file.size > VALIDATION.MAX_FILE_SIZE) {
      setToast({ message: VALIDATION_MESSAGES.FILE_SIZE_ERROR, type: 'error' });
      return;
    }

    setIsUploadingPic(true);
    setShowPicDialog(false);

    try {
      const res = await api.uploadFile('/profile/upload-picture', file);
      if (res.success) {
        updateProfilePic(res.profile_pic ?? null);
        setToast({ message: 'Profile picture updated!', type: 'success' });
      } else {
        setToast({ message: res.error || 'Failed to upload image', type: 'error' });
      }
    } catch {
      setToast({ message: 'Failed to upload image', type: 'error' });
    } finally {
      setIsUploadingPic(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRemovePicture = async () => {
    setIsUploadingPic(true);
    setShowPicDialog(false);

    try {
      const res = await api.delete('/profile/picture');
      if (res.success) {
        updateProfilePic(null);
        setToast({ message: 'Profile picture removed', type: 'success' });
      } else {
        setToast({ message: res.error || 'Failed to remove image', type: 'error' });
      }
    } catch {
      setToast({ message: 'Failed to remove image', type: 'error' });
    } finally {
      setIsUploadingPic(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate(APP_ROUTES.LOGIN);
  };

  const handleBack = () => {
    setIsExiting(true);
    setTimeout(() => {
      navigate(-1);
    }, 200);
  };

  return (
    <>
      <style>{`
        @keyframes slideInFromRight {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        @keyframes slideOutToRight {
          from {
            transform: translateX(0);
            opacity: 1;
          }
          to {
            transform: translateX(100%);
            opacity: 0;
          }
        }
      `}</style>
      <div
        className="container"
        style={{
          maxWidth: '480px',
          padding: '0.5rem 1rem',
          paddingBottom: '2rem',
          animation: isExiting
            ? 'slideOutToRight 0.2s ease-in forwards'
            : 'slideInFromRight 0.25s ease-out',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '0.75rem',
          }}
        >
          <button
            onClick={handleBack}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: '0.25rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '8px',
              transition: 'background-color 0.2s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-secondary)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <ArrowLeft size={20} />
          </button>
          <h1
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              color: 'var(--text-primary)',
              margin: 0,
            }}
          >
            Settings
          </h1>
        </div>

        {/* Profile Section */}
        <ProfileSection
          username={user.username}
          bio={user.bio}
          profilePic={user.profilePic}
          followersCount={followersCount}
          followingCount={followingCount}
          isUploadingPic={isUploadingPic}
          onProfilePicClick={() => {
            if (user.profilePic) {
              setShowFullscreenPic(true);
            } else {
              setShowPicDialog(true);
            }
          }}
          onEditPicClick={() => setShowPicDialog(true)}
          onBioClick={() => setShowBioDialog(true)}
          onFollowersClick={() => setShowFollowListModal('followers')}
          onFollowingClick={() => setShowFollowListModal('following')}
        />

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />

        {/* Badges Section */}
        {!badgesLoading && badges.length > 0 && (
          <div
            className="card"
            style={{
              padding: 0,
              overflow: 'hidden',
              border: '1px solid var(--border)',
              marginBottom: '0.75rem',
            }}
          >
            <div style={{ padding: '0.75rem 1rem' }}>
              <BadgeShowcase
                badges={badges}
                longestStreak={longestStreak}
                showProgress={true}
                size="sm"
              />
            </div>
          </div>
        )}

        {/* Account Settings */}
        <div
          className="card"
          style={{ padding: 0, overflow: 'hidden', border: '1px solid var(--border)' }}
        >
          <SettingsItem
            icon={<User size={18} />}
            label="Username"
            value={`@${user.username}`}
            onClick={() => setShowUsernameDialog(true)}
            showBorder
            iconColor="var(--text-secondary)"
            iconBg="var(--icon-bg-muted)"
          />

          <SettingsItem
            icon={<Key size={18} />}
            label="Password"
            value="••••••••"
            onClick={() => setShowPasswordDialog(true)}
            showBorder
            iconColor="var(--text-secondary)"
            iconBg="var(--icon-bg-muted)"
          />

          {/* Privacy Toggle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0.75rem 1rem',
              gap: '0.75rem',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: 'var(--icon-bg-muted)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              <Lock size={16} />
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                }}
              >
                Private account
              </div>
            </div>
            <button
              onClick={togglePrivacy}
              disabled={isPrivacyLoading}
              style={{
                width: '44px',
                height: '24px',
                borderRadius: '12px',
                border: 'none',
                backgroundColor: isPrivate ? '#0095f6' : 'var(--border)',
                cursor: 'pointer',
                position: 'relative',
                transition: 'background-color 0.2s',
              }}
            >
              <div
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  backgroundColor: 'white',
                  position: 'absolute',
                  top: '3px',
                  left: isPrivate ? '23px' : '3px',
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }}
              />
            </button>
          </div>

          {/* Follow Requests */}
          <div
            onClick={() => setShowFollowRequestsModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0.75rem 1rem',
              gap: '0.75rem',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
              transition: 'background-color 0.2s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-secondary)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor:
                  pendingRequestsCount > 0 ? 'rgba(245, 158, 11, 0.15)' : 'var(--icon-bg-muted)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: pendingRequestsCount > 0 ? '#f59e0b' : 'var(--text-secondary)',
              }}
            >
              <UserPlus size={16} />
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                }}
              >
                Follow requests
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {pendingRequestsCount > 0 && (
                <span
                  style={{
                    backgroundColor: '#f59e0b',
                    color: 'white',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    padding: '0.125rem 0.5rem',
                    borderRadius: '10px',
                    minWidth: '20px',
                    textAlign: 'center',
                  }}
                >
                  {pendingRequestsCount > 99 ? '99+' : pendingRequestsCount}
                </span>
              )}
              <ChevronRight size={18} color="var(--text-tertiary)" />
            </div>
          </div>

          {/* Theme Selection */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0.75rem 1rem',
              gap: '0.75rem',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: 'var(--icon-bg-muted)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              <Palette size={16} />
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                }}
              >
                Theme
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                backgroundColor: 'var(--bg-secondary)',
                padding: '0.25rem',
                borderRadius: '10px',
              }}
            >
              <button
                onClick={() => setTheme('light')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0.5rem',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor: theme === 'light' ? 'var(--bg-primary)' : 'transparent',
                  boxShadow: theme === 'light' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  color: theme === 'light' ? 'var(--accent)' : 'var(--text-secondary)',
                }}
                title="Light theme"
              >
                <Sun size={16} />
              </button>
              <button
                onClick={() => setTheme('dark')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0.5rem',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor: theme === 'dark' ? 'var(--bg-primary)' : 'transparent',
                  boxShadow: theme === 'dark' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  color: theme === 'dark' ? 'var(--accent)' : 'var(--text-secondary)',
                }}
                title="Dark theme"
              >
                <Moon size={16} />
              </button>
              <button
                onClick={() => setTheme('system')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0.5rem',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor: theme === 'system' ? 'var(--bg-primary)' : 'transparent',
                  boxShadow: theme === 'system' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  color: theme === 'system' ? 'var(--accent)' : 'var(--text-secondary)',
                }}
                title="System theme"
              >
                <Monitor size={16} />
              </button>
            </div>
          </div>

          {/* Push Notifications */}
          <PushNotificationsSection onToast={(message, type) => setToast({ message, type })} />

          {/* Log Out */}
          <button
            onClick={() => setShowLogoutDialog(true)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              padding: '0.75rem 1rem',
              gap: '0.75rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ef4444',
              }}
            >
              <LogOut size={16} />
            </div>
            <span
              style={{
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#ef4444',
              }}
            >
              Log out
            </span>
          </button>
        </div>

        {/* Dialogs */}
        <ProfilePictureDialog
          isOpen={showPicDialog}
          onClose={() => setShowPicDialog(false)}
          hasProfilePic={!!user.profilePic}
          onUploadClick={() => fileInputRef.current?.click()}
          onRemoveClick={handleRemovePicture}
        />

        <UsernameDialog
          isOpen={showUsernameDialog}
          onClose={() => setShowUsernameDialog(false)}
          currentUsername={user.username}
          onSuccess={(newUsername) => {
            updateUsername(newUsername);
            setToast({ message: 'Username updated!', type: 'success' });
          }}
        />

        <PasswordDialog
          isOpen={showPasswordDialog}
          onClose={() => setShowPasswordDialog(false)}
          onSuccess={() => {
            setToast({ message: 'Password changed successfully!', type: 'success' });
          }}
        />

        <BioDialog
          isOpen={showBioDialog}
          onClose={() => setShowBioDialog(false)}
          currentBio={user.bio || ''}
          onSuccess={(newBio) => {
            updateBio(newBio || null);
            setToast({ message: 'Bio updated!', type: 'success' });
          }}
        />

        <LogoutDialog
          isOpen={showLogoutDialog}
          onClose={() => setShowLogoutDialog(false)}
          onConfirm={handleLogout}
        />

        {/* Fullscreen Profile Picture */}
        {showFullscreenPic && user.profilePic && (
          <FullscreenProfilePic
            profilePic={user.profilePic}
            username={user.username}
            onClose={() => setShowFullscreenPic(false)}
          />
        )}

        {/* Toast */}
        {toast && (
          <SnapToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        )}

        {/* Follow Requests Modal */}
        <FollowRequestsModal
          isOpen={showFollowRequestsModal}
          onClose={() => setShowFollowRequestsModal(false)}
        />

        {/* Follow List Modal (Followers/Following) */}
        {showFollowListModal && (
          <FollowListModal
            isOpen={!!showFollowListModal}
            onClose={() => setShowFollowListModal(null)}
            userId={user.id}
            username={user.username}
            type={showFollowListModal}
          />
        )}
      </div>
    </>
  );
};
