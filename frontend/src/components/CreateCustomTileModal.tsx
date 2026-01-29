/**
 * CreateCustomTileModal Component
 *
 * A modal for creating and editing custom tiles.
 * Includes icon picker, color picker, and name input.
 * Glassmorphism styled to match app theme.
 */

import { AlertCircle, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { ACTIVITY_CONFIG, PRESET_COLORS } from '../constants';
import type { CustomTile, PredefinedActivityName } from '../types';
import { ACTIVITY_NAMES, MAX_CUSTOM_TILES } from '../types';
import { ColorPicker } from './ColorPicker';
import { DynamicIcon } from './DynamicIcon';
import { IconPicker } from './IconPicker';

interface CreateCustomTileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (tile: CustomTile) => void;
  existingTile?: CustomTile; // For editing mode
  currentTileCount: number;
  existingTiles: CustomTile[]; // All current custom tiles for validation
}

// Generate UUID v4
const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export const CreateCustomTileModal: React.FC<CreateCustomTileModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingTile,
  currentTileCount,
  existingTiles,
}) => {
  const isEditing = !!existingTile;

  const [name, setName] = useState(existingTile?.name || '');
  const [icon, setIcon] = useState(existingTile?.icon || 'Sparkles');
  const [color, setColor] = useState(existingTile?.color || PRESET_COLORS[0]);
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens/closes or existingTile changes
  useEffect(() => {
    if (isOpen) {
      setName(existingTile?.name || '');
      setIcon(existingTile?.icon || 'Sparkles');
      setColor(existingTile?.color || PRESET_COLORS[0]);
      setError(null);
    }
  }, [isOpen, existingTile]);

  const handleSubmit = useCallback(() => {
    // Validate name
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Please enter a name for your tile');
      return;
    }
    if (trimmedName.length > 20) {
      setError('Name cannot exceed 20 characters');
      return;
    }

    // Check for name collision with predefined tiles
    const predefinedMatch = ACTIVITY_NAMES.find((actName) => {
      const config = ACTIVITY_CONFIG[actName as PredefinedActivityName];
      return config && config.label.toLowerCase() === trimmedName.toLowerCase();
    });
    if (predefinedMatch) {
      const config = ACTIVITY_CONFIG[predefinedMatch as PredefinedActivityName];
      setError(`"${config.label}" is a built-in tile name`);
      return;
    }

    // Check for duplicate names (case insensitive)
    const duplicateTile = existingTiles.find(
      (t) => t.name.toLowerCase() === trimmedName.toLowerCase() && t.id !== existingTile?.id
    );
    if (duplicateTile) {
      setError(`A tile named "${duplicateTile.name}" already exists`);
      return;
    }

    // Validate icon
    if (!icon) {
      setError('Please select an icon');
      return;
    }

    // Check limit (only for new tiles)
    if (!isEditing && currentTileCount >= MAX_CUSTOM_TILES) {
      setError(`Maximum of ${MAX_CUSTOM_TILES} custom tiles allowed`);
      return;
    }

    const tile: CustomTile = {
      id: existingTile?.id || generateUUID(),
      name: trimmedName,
      icon,
      color,
    };

    onSave(tile);
    onClose();
  }, [
    name,
    icon,
    color,
    existingTile,
    isEditing,
    currentTileCount,
    existingTiles,
    onSave,
    onClose,
  ]);

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value.length <= 20) {
      setName(value);
      setError(null);
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      />

      {/* Modal */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="hide-scrollbar"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '380px',
          maxHeight: '85vh',
          overflowY: 'auto',
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRadius: '20px',
          border: '1px solid var(--border)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
          animation: 'modalSlideUp 0.3s ease-out',
        }}
      >
        <style>{`
                    .hide-scrollbar {
                        scrollbar-width: none;
                        -ms-overflow-style: none;
                    }
                    .hide-scrollbar::-webkit-scrollbar {
                        display: none;
                    }
                `}</style>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: '1rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            {isEditing ? 'Edit Tile' : 'New Custom Tile'}
          </h2>
          <button
            onClick={onClose}
            style={{
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              color: 'var(--text-tertiary)',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            padding: '16px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          {/* Error Message */}
          {error && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 12px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                borderRadius: '8px',
                color: '#ef4444',
                fontSize: '0.8rem',
              }}
            >
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {/* Preview + Name Row */}
          <div
            style={{
              display: 'flex',
              gap: '16px',
              alignItems: 'flex-start',
            }}
          >
            {/* Mini tile preview */}
            <div
              style={{
                width: '80px',
                height: '80px',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.2rem',
                padding: '0.4rem',
                background: `linear-gradient(135deg, ${color}dd 0%, ${color}aa 100%)`,
                borderRadius: '18px',
                boxShadow: `0 4px 16px ${color}40`,
              }}
            >
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(255, 255, 255, 0.2)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid rgba(255, 255, 255, 0.25)',
                  borderRadius: '50%',
                  flexShrink: 0,
                }}
              >
                <DynamicIcon name={icon} size={18} color="white" />
              </div>
              <span
                style={{
                  fontSize: '0.6rem',
                  fontWeight: 400,
                  color: 'white',
                  textAlign: 'center',
                  lineHeight: 1.1,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  padding: '0 2px',
                }}
              >
                {name || 'Name'}
              </span>
              <span
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  color: 'rgba(255, 255, 255, 0.95)',
                }}
              >
                0h
              </span>
            </div>

            {/* Name Input */}
            <div style={{ flex: 1 }}>
              <label
                style={{
                  display: 'block',
                  marginBottom: '6px',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={handleNameChange}
                placeholder="Enter name..."
                maxLength={20}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: '10px',
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <div
                style={{
                  marginTop: '4px',
                  fontSize: '0.7rem',
                  color: 'var(--text-tertiary)',
                  textAlign: 'right',
                }}
              >
                {name.length}/20
              </div>
            </div>
          </div>

          {/* Icon Picker */}
          <div>
            <label
              style={{
                display: 'block',
                marginBottom: '6px',
                fontSize: '0.75rem',
                fontWeight: 500,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              Icon
            </label>
            <IconPicker value={icon} onChange={setIcon} color={color} />
          </div>

          {/* Color Picker */}
          <div>
            <label
              style={{
                display: 'block',
                marginBottom: '6px',
                fontSize: '0.75rem',
                fontWeight: 500,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              Color
            </label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            gap: '10px',
            padding: '12px 20px 16px',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: '12px',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: '10px',
              color: 'var(--text-primary)',
              fontSize: '0.9rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || !icon}
            style={{
              flex: 1,
              padding: '12px',
              background: name.trim() && icon ? '#0095f6' : 'var(--bg-tertiary)',
              border: 'none',
              borderRadius: '10px',
              color: name.trim() && icon ? 'white' : 'var(--text-tertiary)',
              fontSize: '0.9rem',
              fontWeight: 600,
              cursor: name.trim() && icon ? 'pointer' : 'not-allowed',
            }}
          >
            {isEditing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateCustomTileModal;
