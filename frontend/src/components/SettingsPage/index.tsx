/**
 * SettingsPage Component (Modular Version)
 *
 * The "You" tab: profile card, badges and grouped settings (account, privacy & people,
 * appearance, notifications, help) plus log out.
 */

import { AtSign, HelpCircle, KeyRound, Lock, LogOut, Palette, UserPlus } from 'lucide-react';
import React, { useEffect, useId, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import { VALIDATION, VALIDATION_MESSAGES } from '../../constants/validation';
import { api } from '../../services/api';
import { gl } from '../../services/goodlogs';
import { useAuth, useFollowStore, usePendingRequestsCount, useTheme } from '../../store';
import type { Badge } from '../../types/api';
import { BadgeShowcase } from '../BadgeShowcase';
import { formatDateForApi } from '../Dashboard/Dashboard.constants';
import { FollowListModal, FollowRequestsModal } from '../social';
import { PageHeader, Skeleton, SnapToast, Toggle } from '../ui';
import {
  BioDialog,
  FullscreenProfilePic,
  LogoutDialog,
  PasswordDialog,
  ProfilePictureDialog,
  ProfileSection,
  PushNotificationsSection,
  SettingsItem,
  SettingsSection,
  ThemePicker,
  UsernameDialog,
} from './components';
import { getErrorCode } from './settingsForm';
import styles from './SettingsPage.module.css';
import type { ToastData } from './SettingsPage.types';

const HELP_URL = import.meta.env.PROD ? 'https://help.trackgrowth.in' : 'http://localhost:5174';

const THEME_DESCRIPTIONS = {
  light: 'Bright and airy',
  dark: 'Easy on the eyes',
  system: 'Follows your device setting',
} as const;
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
  const privacyToggleId = useId();

  // Verified badge (from /profile)
  const [isVerified, setIsVerified] = useState(!!user?.isVerified);

  // Badges state
  const [badges, setBadges] = useState<Badge[]>([]);
  const [longestStreak, setLongestStreak] = useState(0);
  const [badgesLoading, setBadgesLoading] = useState(true);

  // Toast
  const [toast, setToast] = useState<ToastData | null>(null);

  // Fetch all data on mount
  useEffect(() => {
    if (user) {
      // Fetch privacy setting
      api
        .get('/get-privacy')
        .then((res) => {
          if (res.success) {
            setIsPrivate(res.is_private);
          }
        })
        .catch((err) => console.warn('[SettingsPage] Failed to load privacy setting', err));

      // Fetch profile data
      api
        .get<{
          success: boolean;
          profile_pic?: string;
          profile_pic_thumb?: string;
          bio?: string;
          is_verified?: boolean;
        }>('/profile')
        .then((res) => {
          if (res.success) {
            if (res.profile_pic) {
              updateProfilePic(res.profile_pic, res.profile_pic_thumb);
            }
            if (res.bio !== undefined) {
              updateBio(res.bio);
            }
            setIsVerified(!!res.is_verified);
          }
        })
        .catch((err) => console.warn('[SettingsPage] Failed to load profile', err));

      // Fetch badges
      api
        .get('/badges')
        .then((res) => {
          if (res.success && res.badges) {
            setBadges(res.badges);
          }
        })
        .catch((err) => console.warn('[SettingsPage] Failed to load badges', err))
        .finally(() => setBadgesLoading(false));

      // Fetch streak for longest.
      // Local calendar date — toISOString() is UTC and is off by a day in many timezones.
      const today = formatDateForApi(new Date());
      api
        .post('/get-streak', { username: user.username, date: today })
        .then((res) => {
          if (res.success && res.data) {
            setLongestStreak(res.data.longest);
          }
        })
        .catch((err) => console.warn('[SettingsPage] Failed to load streak', err));

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
    return <Navigate to={APP_ROUTES.LOGIN} replace />;
  }

  const togglePrivacy = async () => {
    if (isPrivacyLoading) return;
    setIsPrivacyLoading(true);
    const failureMessage = "Couldn't update your privacy setting. Try again.";
    try {
      const res = await api.post('/update-privacy', { is_private: !isPrivate });
      if (res.success) {
        gl.track('privacy_toggled', { properties: { isPrivate: res.is_private } });
        setIsPrivate(res.is_private);
        setToast({
          message: res.is_private ? 'Your account is now private' : 'Your account is now public',
          type: 'success',
        });
      } else {
        console.warn('[Settings] Privacy update rejected', { code: res.error_code });
        setToast({ message: failureMessage, type: 'error' });
      }
    } catch (err) {
      console.error('[Settings] Failed to update privacy', { code: getErrorCode(err) });
      setToast({ message: failureMessage, type: 'error' });
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
        updateProfilePic(res.profile_pic ?? null, res.profile_pic_thumb ?? null);
        setToast({ message: 'Profile picture updated!', type: 'success' });
      } else {
        setToast({ message: res.error || 'Failed to upload image', type: 'error' });
      }
    } catch (err) {
      console.warn('[Settings] Profile photo upload failed', { code: getErrorCode(err) });
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
        updateProfilePic(null, null);
        setToast({ message: 'Profile picture removed', type: 'success' });
      } else {
        setToast({ message: res.error || 'Failed to remove image', type: 'error' });
      }
    } catch (err) {
      console.warn('[Settings] Profile photo removal failed', { code: getErrorCode(err) });
      setToast({ message: 'Failed to remove image', type: 'error' });
    } finally {
      setIsUploadingPic(false);
    }
  };

  const handleLogout = () => {
    logout();
    // Replace so Back after signing out cannot return to a protected screen
    navigate(APP_ROUTES.LOGIN, { replace: true });
  };

  return (
    <div className={styles.page}>
      {/* Settings is a tab root (Profile tab) — title only, no Back button */}
      <PageHeader title="Settings" />

      <ProfileSection
        username={user.username}
        bio={user.bio}
        profilePic={user.profilePic}
        profilePicThumb={user.profilePicThumb}
        followersCount={followersCount}
        followingCount={followingCount}
        isUploadingPic={isUploadingPic}
        isVerified={isVerified}
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
        className={styles.fileInput}
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Badges */}
      {badgesLoading ? (
        <div className={styles.badgesCard} aria-hidden="true">
          <Skeleton width="45%" height={18} radius="full" />
          <div className={styles.badgesSkeletonRow}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} width={48} height={48} radius="full" />
            ))}
          </div>
          <Skeleton height={8} radius="full" />
        </div>
      ) : (
        badges.length > 0 && (
          <div className={styles.badgesCard}>
            <BadgeShowcase
              badges={badges}
              longestStreak={longestStreak}
              showProgress={true}
              size="sm"
            />
          </div>
        )
      )}

      <SettingsSection title="Account">
        <SettingsItem
          icon={<AtSign size={18} strokeWidth={2.25} />}
          tone="violet"
          label="Username"
          value={`@${user.username}`}
          onClick={() => setShowUsernameDialog(true)}
        />
        <SettingsItem
          icon={<KeyRound size={18} strokeWidth={2.25} />}
          tone="amber"
          label="Password"
          value="Change your password"
          onClick={() => setShowPasswordDialog(true)}
        />
      </SettingsSection>

      <SettingsSection title="Privacy & people">
        <SettingsItem
          icon={<Lock size={18} strokeWidth={2.25} />}
          tone="teal"
          label="Private account"
          value={
            isPrivate
              ? 'Only approved followers can see your days and insights'
              : 'Anyone can see your days and insights'
          }
          controlId={privacyToggleId}
          trailing={
            <Toggle
              id={privacyToggleId}
              checked={isPrivate}
              onChange={togglePrivacy}
              busy={isPrivacyLoading}
              aria-labelledby={`${privacyToggleId}-label`}
              aria-describedby={`${privacyToggleId}-description`}
            />
          }
        />
        <SettingsItem
          icon={<UserPlus size={18} strokeWidth={2.25} />}
          tone="pink"
          label="Follow requests"
          value={
            pendingRequestsCount > 0
              ? `${pendingRequestsCount} waiting for your answer`
              : 'No pending requests'
          }
          badge={pendingRequestsCount}
          onClick={() => setShowFollowRequestsModal(true)}
        />
      </SettingsSection>

      <SettingsSection title="Appearance">
        <SettingsItem
          icon={<Palette size={18} strokeWidth={2.25} />}
          tone="indigo"
          label="Theme"
          value={THEME_DESCRIPTIONS[theme]}
        />
        <div className={styles.themePicker}>
          <ThemePicker value={theme} onChange={setTheme} />
        </div>
      </SettingsSection>

      <PushNotificationsSection onToast={(message, type) => setToast({ message, type })} />

      <SettingsSection title="Help">
        <SettingsItem
          icon={<HelpCircle size={18} strokeWidth={2.25} />}
          tone="green"
          label="FAQs & help"
          value="Answers to common questions"
          href={HELP_URL}
          external
        />
      </SettingsSection>

      <SettingsSection ariaLabel="Session">
        <SettingsItem
          icon={<LogOut size={18} strokeWidth={2.25} />}
          label="Log out"
          danger
          onClick={() => setShowLogoutDialog(true)}
        />
      </SettingsSection>

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
          profilePicThumb={user.profilePicThumb}
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
  );
};
