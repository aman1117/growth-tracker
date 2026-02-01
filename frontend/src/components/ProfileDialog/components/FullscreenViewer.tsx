/**
 * FullscreenViewer Component
 *
 * Fullscreen profile picture viewer.
 */

import { X } from 'lucide-react';
import React from 'react';

import { ProtectedImage } from '../../ui';

interface FullscreenViewerProps {
  profilePic: string;
  username: string;
  onClose: () => void;
}

export const FullscreenViewer: React.FC<FullscreenViewerProps> = ({
  profilePic,
  username,
  onClose,
}) => {
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
      {/* Close button */}
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
          transition: 'background-color 0.2s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)')}
      >
        <X size={24} />
      </button>

      {/* Profile image */}
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
        }}
      />

      {/* Username label */}
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
