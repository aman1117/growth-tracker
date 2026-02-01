/**
 * UndoDeleteToast Component
 *
 * Toast notification with undo capability for deleted tiles.
 */

import { Undo2, X } from 'lucide-react';
import React from 'react';

interface UndoDeleteToastProps {
  tileName: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export const UndoDeleteToast: React.FC<UndoDeleteToastProps> = ({
  tileName,
  onUndo,
  onDismiss,
}) => {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: '24px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10001,
        animation: 'undoToastSlideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
      }}
    >
      <style>{`
        @keyframes undoToastSlideUp {
          0% {
            opacity: 0;
            transform: translateX(-50%) translateY(16px) scale(0.95);
          }
          100% {
            opacity: 1;
            transform: translateX(-50%) translateY(0) scale(1);
          }
        }
        @keyframes undoProgress {
          0% { width: 100%; }
          100% { width: 0%; }
        }
      `}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '10px 12px 10px 20px',
          background: 'var(--bg-secondary)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderRadius: '100px',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          boxShadow: '0 8px 32px var(--shadow-md), 0 0 20px rgba(239, 68, 68, 0.1)',
          position: 'relative',
          overflow: 'hidden',
          minWidth: '300px',
        }}
      >
        {/* Progress bar */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            height: '2px',
            background: 'linear-gradient(90deg, #ef4444, #f97316)',
            borderRadius: '0 0 100px 100px',
            animation: 'undoProgress 8s linear forwards',
          }}
        />

        {/* Text */}
        <span
          style={{
            flex: 1,
            fontSize: '0.875rem',
            color: 'var(--text-primary)',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ color: '#ef4444' }}>Deleted</span>{' '}
          <span style={{ fontWeight: 500 }}>{tileName}</span>
        </span>

        {/* Undo button */}
        <button
          onClick={onUndo}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            padding: '6px 12px',
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '100px',
            color: '#ef4444',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.25)';
            e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.5)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)';
            e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.3)';
          }}
        >
          <Undo2 size={14} />
          Undo
        </button>

        {/* Dismiss button */}
        <button
          onClick={onDismiss}
          style={{
            padding: '6px',
            background: 'transparent',
            border: 'none',
            borderRadius: '50%',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'color 0.15s ease',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
};
