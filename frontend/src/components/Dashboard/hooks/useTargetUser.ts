/**
 * useTargetUser Hook
 *
 * Manages target user profile data when viewing own or others' dashboards.
 * Handles fetching profile info, photos, and follow relationships.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../../../services/api';
import { useAuth, useFollowStore } from '../../../store';
import type { ActivityPhoto } from '../../../types';

interface UseTargetUserReturn {
  targetUsername: string | undefined;
  targetUserId: number | null;
  targetProfilePic: string | null;
  targetBio: string | null;
  targetIsVerified: boolean;
  targetIsPrivate: boolean;
  targetLastLoggedAt: string | null;
  isReadOnly: boolean;
  targetUserPhotos: ActivityPhoto[];
  setTargetUserPhotos: React.Dispatch<React.SetStateAction<ActivityPhoto[]>>;
  targetUserPhotosOwnerId: number | null;
  setTargetUserPhotosOwnerId: React.Dispatch<React.SetStateAction<number | null>>;
  showTargetFullscreenPic: boolean;
  setShowTargetFullscreenPic: React.Dispatch<React.SetStateAction<boolean>>;
  fetchActivities: () => void;
}

interface UseTargetUserProps {
  fetchActivities: () => void;
}

export const useTargetUser = ({ fetchActivities }: UseTargetUserProps): UseTargetUserReturn => {
  const { user } = useAuth();
  const { username: routeUsername } = useParams<{ username: string }>();
  const { lookupRelationships } = useFollowStore();

  // Determine if we are viewing another user's profile
  const targetUsername = routeUsername || user?.username;
  const isReadOnly = !!(routeUsername && routeUsername !== user?.username);

  // Target user's profile pic and bio (when viewing another user's dashboard)
  const [targetProfilePic, setTargetProfilePic] = useState<string | null>(null);
  const [targetBio, setTargetBio] = useState<string | null>(null);
  const [targetIsVerified, setTargetIsVerified] = useState<boolean>(false);
  const [targetUserId, setTargetUserId] = useState<number | null>(null);
  const [targetIsPrivate, setTargetIsPrivate] = useState<boolean>(false);
  const [targetLastLoggedAt, setTargetLastLoggedAt] = useState<string | null>(null);
  const [showTargetFullscreenPic, setShowTargetFullscreenPic] = useState(false);

  // Target user's photos for story viewing (when viewing another user's profile)
  const [targetUserPhotos, setTargetUserPhotos] = useState<ActivityPhoto[]>([]);
  // Track which user's photos are currently loaded (prevents blue ring flash when switching profiles)
  const [targetUserPhotosOwnerId, setTargetUserPhotosOwnerId] = useState<number | null>(null);

  // Listen for follow-accepted events to refresh profile data
  useEffect(() => {
    const handleFollowAccepted = (
      event: CustomEvent<{ actorId: number; actorUsername: string }>
    ) => {
      // If we're viewing the profile of the user who accepted our request, refresh
      if (
        isReadOnly &&
        targetUsername?.toLowerCase() === event.detail.actorUsername?.toLowerCase()
      ) {
        console.log('[useTargetUser] Follow accepted, refreshing profile data');
        fetchActivities();
      }
    };

    window.addEventListener('follow-accepted', handleFollowAccepted as EventListener);
    return () =>
      window.removeEventListener('follow-accepted', handleFollowAccepted as EventListener);
  }, [isReadOnly, targetUsername, fetchActivities]);

  // Reset target user photos immediately when switching profiles to prevent blue ring flash
  // This runs synchronously before the async profile fetch
  useEffect(() => {
    if (isReadOnly) {
      setTargetUserPhotos([]);
      setTargetUserPhotosOwnerId(null);
    }
  }, [isReadOnly, targetUsername]);

  // Fetch target user's profile pic and bio when viewing another user's dashboard
  useEffect(() => {
    const fetchTargetUserProfile = async () => {
      if (isReadOnly && targetUsername) {
        // Reset state when switching users
        setTargetProfilePic(null);
        setTargetBio(null);
        setTargetIsVerified(false);
        setTargetUserId(null);
        setTargetIsPrivate(false);
        setTargetLastLoggedAt(null);

        try {
          const res = await api.post('/users', { username: targetUsername });
          if (res.success && res.data && res.data.length > 0) {
            const exactMatch = res.data.find(
              (u: { username: string }) => u.username.toLowerCase() === targetUsername.toLowerCase()
            );
            if (exactMatch) {
              setTargetProfilePic(exactMatch.profile_pic || null);
              // Bio is only returned for public profiles (backend handles privacy)
              setTargetBio(exactMatch.bio || null);
              setTargetIsVerified(exactMatch.is_verified || false);
              setTargetUserId(exactMatch.id || null);
              setTargetIsPrivate(exactMatch.is_private || false);

              // Lookup relationship state to get pending status
              if (exactMatch.id) {
                await lookupRelationships([exactMatch.id]);

                // Fetch full profile to get last_logged_at (privacy-aware)
                try {
                  const profileRes = await api.get(`/users/${exactMatch.id}/profile`);
                  if (profileRes.success && profileRes.last_logged_at) {
                    setTargetLastLoggedAt(profileRes.last_logged_at);
                  }
                } catch {
                  // Silently fail - last_logged_at is optional
                }
              }
            }
          }
        } catch (err) {
          console.error('[useTargetUser] Failed to fetch target user profile', err);
        }
      }
    };
    fetchTargetUserProfile();
  }, [isReadOnly, targetUsername, lookupRelationships]);

  // Set targetUserId for own profile (needed for story circles)
  // Also reset target user state when navigating back to own profile to prevent stale data
  useEffect(() => {
    if (!isReadOnly && user?.id) {
      // Reset any stale target user state from viewing other profiles
      // This prevents showing other user's photos when clicking "Your Story"
      setTargetUserPhotos([]);
      setTargetUserPhotosOwnerId(null);
      setTargetUserId(user.id);
    }
  }, [isReadOnly, user?.id]);

  return {
    targetUsername,
    targetUserId,
    targetProfilePic,
    targetBio,
    targetIsVerified,
    targetIsPrivate,
    targetLastLoggedAt,
    isReadOnly,
    targetUserPhotos,
    setTargetUserPhotos,
    targetUserPhotosOwnerId,
    setTargetUserPhotosOwnerId,
    showTargetFullscreenPic,
    setShowTargetFullscreenPic,
    fetchActivities,
  };
};
