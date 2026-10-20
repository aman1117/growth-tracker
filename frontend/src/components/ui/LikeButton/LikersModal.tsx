/**
 * LikersModal Component
 *
 * Lists everyone who liked a specific day. Clicking a user opens their profile.
 * Built on the shared Modal (focus/escape/back-gesture/scroll-lock handled there).
 */

import { Heart, RefreshCw } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { APP_ROUTES } from '../../../constants/routes';
import { useOverlayAwareNavigate } from '../../../hooks/useOverlayAwareNavigate';
import { likeApi } from '../../../services/api';
import type { LikerDTO } from '../../../types/api';
import { Avatar } from '../Avatar';
import { Modal } from '../Modal';
import { Skeleton } from '../Skeleton';
import { VerifiedBadge } from '../VerifiedBadge';
import styles from './LikersModal.module.css';

export interface LikersModalProps {
  /** Username of the profile being viewed */
  username: string;
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
}

type LoadStatus = 'loading' | 'ready' | 'error';

const SKELETON_ROWS = 3;

export const LikersModal: React.FC<LikersModalProps> = ({ username, date, isOpen, onClose }) => {
  const navigate = useOverlayAwareNavigate();
  const [likers, setLikers] = useState<LikerDTO[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isOpen) return;

    // Ignore responses that arrive after the modal closed or the day changed
    let cancelled = false;

    const fetchLikers = async () => {
      setStatus('loading');
      try {
        const response = await likeApi.getLikes(username, date);
        if (cancelled) return;
        if (response.success) {
          setLikers(response.data || []);
          setStatus('ready');
        } else {
          console.warn('[LikersModal] getLikes returned unsuccessful response', { date });
          setStatus('error');
        }
      } catch (error) {
        if (cancelled) return;
        console.error('[LikersModal] Failed to fetch likers; showing retry', { date, error });
        setStatus('error');
      }
    };

    fetchLikers();

    return () => {
      cancelled = true;
    };
  }, [username, date, isOpen, reloadKey]);

  const handleUserClick = (likerUsername: string) => {
    // Navigate first so the modal's history entry is replaced by the profile
    navigate(APP_ROUTES.USER_PROFILE(likerUsername));
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Likes" size="small" maxWidth="360px">
      {status === 'loading' && (
        <div className={styles.list} aria-busy="true" aria-label="Loading likes">
          {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
            <div key={i} className={styles.skeletonRow}>
              <Skeleton width={40} height={40} radius="full" />
              <Skeleton width={i === 1 ? '42%' : '58%'} height={14} radius="sm" />
            </div>
          ))}
        </div>
      )}

      {status === 'error' && (
        <div className={styles.state} role="alert">
          <span className={`${styles.stateIcon} ${styles.stateIconError}`} aria-hidden="true">
            <Heart size={22} />
          </span>
          <p className={styles.stateTitle}>Couldn't load likes</p>
          <p className={styles.stateText}>Check your connection and try again.</p>
          <button className={styles.retry} onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshCw size={14} strokeWidth={2.5} aria-hidden="true" />
            Try again
          </button>
        </div>
      )}

      {status === 'ready' && likers.length === 0 && (
        <div className={styles.state}>
          <span className={styles.stateIcon} aria-hidden="true">
            <Heart size={22} />
          </span>
          <p className={styles.stateTitle}>No likes yet</p>
          <p className={styles.stateText}>Likes on this day will show up here.</p>
        </div>
      )}

      {status === 'ready' && likers.length > 0 && (
        <ul className={styles.list}>
          {likers.map((liker) => (
            <li key={liker.id}>
              <button
                type="button"
                className={styles.row}
                onClick={() => handleUserClick(liker.username)}
                aria-label={`Open ${liker.username}'s profile`}
              >
                <Avatar
                  src={liker.profile_pic}
                  thumbnailSrc={liker.profile_pic_thumb}
                  name={liker.username}
                  size="md"
                />
                <span className={styles.name}>
                  <span className={styles.username}>{liker.username}</span>
                  {liker.is_verified && <VerifiedBadge size={14} />}
                </span>
                <Heart
                  size={16}
                  className={styles.rowHeart}
                  fill="currentColor"
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
};

export default LikersModal;
