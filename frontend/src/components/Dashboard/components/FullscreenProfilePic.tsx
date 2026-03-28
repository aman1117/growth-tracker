/**
 * FullscreenProfilePic Component
 *
 * Displays a fullscreen view of a user's profile picture.
 */

import { X } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { ProtectedImage } from '../../ui';

interface FullscreenProfilePicProps {
  profilePic: string;
  profilePicThumb?: string | null;
  username: string;
  onClose: () => void;
}

export const FullscreenProfilePic: React.FC<FullscreenProfilePicProps> = ({
  profilePic,
  profilePicThumb,
  username,
  onClose,
}) => {
  const [fullLoaded, setFullLoaded] = useState(false);

  // Preload full image in background
  useEffect(() => {
    if (!profilePicThumb) return;
    const img = new Image();
    img.onload = () => setFullLoaded(true);
    img.src = profilePic;
    return () => {
      img.onload = null;
    };
  }, [profilePic, profilePicThumb]);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.95)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        cursor: 'zoom-out',
        animation: 'fadeIn 0.2s ease-out',
      }}
    >
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: '20px',
          right: '20px',
          width: '40px',
          height: '40px',
          borderRadius: '50%',
          border: 'none',
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          color: 'white',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={24} />
      </button>
      <div
        style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {profilePicThumb && !fullLoaded && (
          <ProtectedImage
            src={profilePicThumb}
            alt={username}
            style={{
              maxWidth: '90vw',
              maxHeight: '90vh',
              objectFit: 'contain',
              borderRadius: '8px',
              cursor: 'default',
              filter: 'blur(10px)',
              transform: 'scale(1.05)',
              animation: 'scaleIn 0.2s ease-out',
            }}
          />
        )}
        <ProtectedImage
          src={profilePic}
          alt={username}
          style={{
            maxWidth: '90vw',
            maxHeight: '90vh',
            objectFit: 'contain',
            borderRadius: '8px',
            cursor: 'default',
            animation: 'scaleIn 0.2s ease-out',
            ...(profilePicThumb
              ? {
                  position: fullLoaded ? 'relative' : 'absolute',
                  top: 0,
                  left: 0,
                  opacity: fullLoaded ? 1 : 0,
                  transition: 'opacity 0.3s ease',
                }
              : {}),
          }}
        />
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: '30px',
          left: '50%',
          transform: 'translateX(-50%)',
          color: 'white',
          fontSize: '1rem',
          fontWeight: 500,
          padding: '8px 16px',
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          borderRadius: '20px',
        }}
      >
        {username}
      </div>
    </div>
  );
};
