/**
 * EditModeToolbar Component
 *
 * Displays the edit mode controls including instructions,
 * manage tiles button, cancel and done buttons.
 */

import { EyeOff, GripVertical, Settings2 } from 'lucide-react';
import React from 'react';

interface EditModeToolbarProps {
  hiddenTilesCount: number;
  onManageTiles: () => void;
  onCancel: () => void;
  onSave: () => void;
}

export const EditModeToolbar: React.FC<EditModeToolbarProps> = ({
  hiddenTilesCount,
  onManageTiles,
  onCancel,
  onSave,
}) => {
  return (
    <div
      style={{
        position: 'sticky',
        top: '16px',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'space-between',
        padding: '14px 16px',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderRadius: '12px',
        marginBottom: '12px',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
        animation: 'editBarSlideIn 0.25s ease-out',
        gap: '16px',
        zIndex: 50,
      }}
    >
      <style>{`
        @keyframes editBarSlideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Left: Instructions stacked vertically */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
          }}
        >
          <GripVertical size={14} style={{ color: '#0095f6' }} />
          <span>Drag to reorder</span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
          }}
        >
          <span style={{ width: '14px', textAlign: 'center', color: '#0095f6' }}>↔</span>
          <span>Tap to resize</span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
          }}
        >
          <span
            style={{ width: '14px', textAlign: 'center', color: '#ef4444', fontWeight: 600 }}
          >
            ✕
          </span>
          <span>Tap X to hide</span>
        </div>
      </div>

      {/* Right: Buttons stacked vertically */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
        <button
          onClick={onManageTiles}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            padding: '8px 16px',
            background:
              hiddenTilesCount > 0 ? 'rgba(251, 191, 36, 0.15)' : 'rgba(0, 149, 246, 0.1)',
            color: hiddenTilesCount > 0 ? '#fbbf24' : '#0095f6',
            border:
              hiddenTilesCount > 0
                ? '1px solid rgba(251, 191, 36, 0.3)'
                : '1px solid rgba(0, 149, 246, 0.3)',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '0.85rem',
            fontWeight: 500,
          }}
        >
          {hiddenTilesCount > 0 ? <EyeOff size={14} /> : <Settings2 size={14} />}
          {hiddenTilesCount > 0 ? `${hiddenTilesCount} Hidden` : 'Manage Tiles'}
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '8px 20px',
            backgroundColor: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '0.85rem',
            fontWeight: 500,
          }}
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          style={{
            padding: '8px 20px',
            background: 'linear-gradient(135deg, #0095f6 0%, #0077cc 100%)',
            color: '#ffffff',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '0.85rem',
            fontWeight: 600,
            boxShadow: '0 2px 8px rgba(0, 149, 246, 0.3)',
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
};
