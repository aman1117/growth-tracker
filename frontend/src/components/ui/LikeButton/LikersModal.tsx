/**
 * LikersModal Component
 *
 * A modal that displays all users who liked a specific day.
 * Clicking on a user navigates to their dashboard.
 */

import { Heart, User as UserIcon, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import { likeApi } from '../../../services/api';
import type { LikerDTO } from '../../../types/api';
import { ProtectedImage } from '../ProtectedImage';
import { VerifiedBadge } from '../VerifiedBadge';

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

export const LikersModal: React.FC<LikersModalProps> = ({ username, date, isOpen, onClose }) => {
  const navigate = useNavigate();
  const [likers, setLikers] = useState<LikerDTO[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isOpen) return;

    const fetchLikers = async () => {
      setLoading(true);
      try {
        const response = await likeApi.getLikes(username, date);
        if (response.success) {
          setLikers(response.data || []);
        }
      } catch (error) {
        console.error('Failed to fetch likers:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchLikers();
  }, [username, date, isOpen]);

  const handleUserClick = (likerUsername: string) => {
    onClose();
    navigate(`/user/${likerUsername}`);
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        zIndex: 100,
        padding: '1rem',
        paddingTop: '15vh',
        overflowY: 'auto',
      }}
    >
      <style>{`
        @keyframes modalSlideIn {
          from {
            opacity: 0;
            transform: translateY(-10px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        .liker-row:hover {
          background-color: var(--hover-bg) !important;
        }
      `}</style>

      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: '320px',
          maxHeight: '50vh',
          display: 'flex',
          flexDirection: 'column',
          animation: 'modalSlideIn 0.2s ease-out',
          overflow: 'hidden',
          padding: '0.5rem 0',
          position: 'relative',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.5rem 1rem 0.75rem',
            borderBottom: '1px solid var(--tile-glass-border)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Heart size={16} color="#ef4444" fill="#ef4444" />
            <span
              style={{
                fontWeight: 600,
                fontSize: '0.95rem',
                color: 'var(--text-primary)',
              }}
            >
              Likes
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0.25rem',
              color: 'var(--text-secondary)',
              display: 'flex',
              alignItems: 'center',
              transition: 'color 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
          }}
        >
          {loading ? (
            <div
              style={{
                padding: '2rem',
                textAlign: 'center',
                color: 'var(--text-secondary)',
                fontSize: '0.875rem',
              }}
            >
              Loading...
            </div>
          ) : likers.length === 0 ? (
            <div
              style={{
                padding: '2rem',
                textAlign: 'center',
                color: 'var(--text-secondary)',
                fontSize: '0.875rem',
              }}
            >
              No likes yet
            </div>
          ) : (
            likers.map((liker, index) => (
              <div
                key={liker.id}
                className="liker-row"
                onClick={() => handleUserClick(liker.username)}
                style={{
                  padding: '0.5rem 1rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  transition: 'background-color 0.15s ease',
                  borderBottom:
                    index < likers.length - 1 ? '1px solid var(--tile-glass-border)' : 'none',
                }}
              >
                {/* Avatar */}
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    backgroundColor: 'var(--avatar-bg)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    flexShrink: 0,
                  }}
                >
                  {liker.profile_pic ? (
                    <ProtectedImage
                      src={liker.profile_pic}
                      alt={liker.username}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <UserIcon size={16} color="var(--text-secondary)" />
                  )}
                </div>

                {/* Username with Verified Badge */}
                <span
                  style={{
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                  }}
                >
                  {liker.username}
                  {liker.is_verified && <VerifiedBadge size={14} />}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default LikersModal;
