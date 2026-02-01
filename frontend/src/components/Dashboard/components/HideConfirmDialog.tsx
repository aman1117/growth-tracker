/**
 * HideConfirmDialog Component
 *
 * Confirmation dialog for hiding a tile from the dashboard.
 */

import { EyeOff } from 'lucide-react';
import React from 'react';

interface HideConfirmDialogProps {
  displayName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const HideConfirmDialog: React.FC<HideConfirmDialogProps> = ({
  displayName,
  onConfirm,
  onCancel,
}) => {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '16px',
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-primary)',
          borderRadius: '16px',
          padding: '24px',
          width: '300px',
          maxWidth: '90vw',
          border: '1px solid var(--border)',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3)',
          animation: 'hideConfirmScaleIn 0.2s ease-out',
        }}
      >
        <style>{`
          @keyframes hideConfirmScaleIn {
            from {
              opacity: 0;
              transform: scale(0.9);
            }
            to {
              opacity: 1;
              transform: scale(1);
            }
          }
        `}</style>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              background: 'rgba(251, 191, 36, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '16px',
            }}
          >
            <EyeOff size={24} color="#f59e0b" />
          </div>
          <h3
            style={{
              margin: '0 0 8px',
              fontSize: '1rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            Hide Tile?
          </h3>
          <p
            style={{
              margin: '0 0 20px',
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              lineHeight: 1.4,
            }}
          >
            Hide{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              "{displayName}"
            </strong>{' '}
            from your dashboard? You can restore it anytime from the hidden tiles panel.
          </p>
          <div
            style={{
              display: 'flex',
              gap: '12px',
              width: '100%',
            }}
          >
            <button
              onClick={onCancel}
              style={{
                flex: 1,
                padding: '12px 16px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '12px',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              style={{
                flex: 1,
                padding: '12px 16px',
                background: 'linear-gradient(135deg, #0095f6 0%, #0077cc 100%)',
                border: 'none',
                borderRadius: '12px',
                color: 'white',
                fontSize: '0.9rem',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(0, 149, 246, 0.3)',
              }}
            >
              Hide
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
