/**
 * CreateCustomTileModal Component
 * 
 * A modal for creating and editing custom tiles.
 * Includes icon picker, color picker, and name input.
 * Glassmorphism styled to match app theme.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { X, AlertCircle } from 'lucide-react';
import { IconPicker } from './IconPicker';
import { ColorPicker, PRESET_COLORS } from './ColorPicker';
import { DynamicIcon } from './DynamicIcon';
import type { CustomTile, PredefinedActivityName } from '../types';
import { MAX_CUSTOM_TILES, ACTIVITY_NAMES } from '../types';
import { ACTIVITY_CONFIG } from '../constants';

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
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
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
    }, [name, icon, color, existingTile, isEditing, currentTileCount, existingTiles, onSave, onClose]);

    const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        if (value.length <= 20) {
            setName(value);
            setError(null);
        }
    }, []);

    if (!isOpen) return null;

    const remainingTiles = MAX_CUSTOM_TILES - currentTileCount;

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
                    maxWidth: '420px',
                    maxHeight: '90vh',
                    overflowY: 'auto',
                    background: 'var(--glass-bg)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    borderRadius: '24px',
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
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '20px 24px',
                    borderBottom: '1px solid var(--border)',
                }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                    }}>
                        <div style={{
                            width: '40px',
                            height: '40px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: `${color}20`,
                            borderRadius: '12px',
                        }}>
                            <DynamicIcon name={icon} size={22} color={color} />
                        </div>
                        <div>
                            <h2 style={{
                                margin: 0,
                                fontSize: '1.1rem',
                                fontWeight: 600,
                                color: 'var(--text-primary)',
                            }}>
                                {isEditing ? 'Edit Custom Tile' : 'Create Custom Tile'}
                            </h2>
                            {!isEditing && (
                                <p style={{
                                    margin: 0,
                                    fontSize: '0.8rem',
                                    color: 'var(--text-tertiary)',
                                }}>
                                    {remainingTiles} of {MAX_CUSTOM_TILES} remaining
                                </p>
                            )}
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        style={{
                            width: '36px',
                            height: '36px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border)',
                            borderRadius: '10px',
                            cursor: 'pointer',
                            color: 'var(--text-secondary)',
                        }}
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div style={{
                    padding: '24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '24px',
                }}>
                    {/* Error Message */}
                    {error && (
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '12px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            borderRadius: '10px',
                            color: '#ef4444',
                            fontSize: '0.85rem',
                        }}>
                            <AlertCircle size={18} />
                            {error}
                        </div>
                    )}

                    {/* Name Input */}
                    <div>
                        <label style={{
                            display: 'block',
                            marginBottom: '8px',
                            fontSize: '0.85rem',
                            fontWeight: 500,
                            color: 'var(--text-secondary)',
                        }}>
                            Tile Name
                        </label>
                        <input
                            type="text"
                            value={name}
                            onChange={handleNameChange}
                            placeholder="Enter tile name..."
                            maxLength={20}
                            style={{
                                width: '100%',
                                padding: '12px 16px',
                                background: 'var(--bg-secondary)',
                                border: '1px solid var(--border)',
                                borderRadius: '12px',
                                color: 'var(--text-primary)',
                                fontSize: '1rem',
                                outline: 'none',
                                boxSizing: 'border-box',
                            }}
                        />
                        <div style={{
                            marginTop: '4px',
                            fontSize: '0.75rem',
                            color: 'var(--text-tertiary)',
                            textAlign: 'right',
                        }}>
                            {name.length}/20
                        </div>
                    </div>

                    {/* Your Existing Tiles - only show if there are tiles and not editing */}
                    {!isEditing && existingTiles.length > 0 && (
                        <div>
                            <label style={{
                                display: 'block',
                                marginBottom: '8px',
                                fontSize: '0.85rem',
                                fontWeight: 500,
                                color: 'var(--text-secondary)',
                            }}>
                                Your Tiles
                            </label>
                            <div style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: '8px',
                            }}>
                                {existingTiles.map((tile) => (
                                    <div
                                        key={tile.id}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                            padding: '6px 10px',
                                            background: `${tile.color}15`,
                                            border: `1px solid ${tile.color}30`,
                                            borderRadius: '8px',
                                            fontSize: '0.8rem',
                                            color: 'var(--text-primary)',
                                        }}
                                    >
                                        <DynamicIcon name={tile.icon} size={14} color={tile.color} />
                                        <span style={{ 
                                            maxWidth: '100px', 
                                            overflow: 'hidden', 
                                            textOverflow: 'ellipsis', 
                                            whiteSpace: 'nowrap' 
                                        }}>
                                            {tile.name}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Icon Picker */}
                    <div>
                        <label style={{
                            display: 'block',
                            marginBottom: '8px',
                            fontSize: '0.85rem',
                            fontWeight: 500,
                            color: 'var(--text-secondary)',
                        }}>
                            Icon
                        </label>
                        <IconPicker
                            value={icon}
                            onChange={setIcon}
                            color={color}
                        />
                    </div>

                    {/* Color Picker */}
                    <div>
                        <label style={{
                            display: 'block',
                            marginBottom: '8px',
                            fontSize: '0.85rem',
                            fontWeight: 500,
                            color: 'var(--text-secondary)',
                        }}>
                            Color
                        </label>
                        <ColorPicker
                            value={color}
                            onChange={setColor}
                        />
                    </div>

                    {/* Preview */}
                    <div>
                        <label style={{
                            display: 'block',
                            marginBottom: '8px',
                            fontSize: '0.85rem',
                            fontWeight: 500,
                            color: 'var(--text-secondary)',
                        }}>
                            Preview
                        </label>
                        <div style={{
                            display: 'flex',
                            justifyContent: 'center',
                            padding: '20px',
                            background: 'var(--bg-secondary)',
                            borderRadius: '16px',
                            border: '1px solid var(--border)',
                        }}>
                            {/* Mini tile preview */}
                            <div style={{
                                width: '100px',
                                height: '100px',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '8px',
                                background: `linear-gradient(135deg, ${color}dd 0%, ${color}aa 100%)`,
                                borderRadius: '24px',
                                boxShadow: `0 4px 20px ${color}50`,
                            }}>
                                <div style={{
                                    width: '36px',
                                    height: '36px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    background: 'rgba(255, 255, 255, 0.2)',
                                    borderRadius: '50%',
                                }}>
                                    <DynamicIcon name={icon} size={20} color="white" />
                                </div>
                                <span style={{
                                    fontSize: '0.65rem',
                                    fontWeight: 400,
                                    color: 'white',
                                    textAlign: 'center',
                                    maxWidth: '80px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                }}>
                                    {name || 'Tile Name'}
                                </span>
                                <span style={{
                                    fontSize: '0.9rem',
                                    fontWeight: 600,
                                    color: 'rgba(255, 255, 255, 0.95)',
                                }}>
                                    0h
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div style={{
                    display: 'flex',
                    gap: '12px',
                    padding: '20px 24px',
                    borderTop: '1px solid var(--border)',
                }}>
                    <button
                        onClick={onClose}
                        style={{
                            flex: 1,
                            padding: '12px',
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border)',
                            borderRadius: '12px',
                            color: 'var(--text-secondary)',
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
                            background: name.trim() && icon ? color : 'var(--bg-tertiary)',
                            border: 'none',
                            borderRadius: '12px',
                            color: name.trim() && icon ? 'white' : 'var(--text-tertiary)',
                            fontSize: '0.9rem',
                            fontWeight: 600,
                            cursor: name.trim() && icon ? 'pointer' : 'not-allowed',
                            boxShadow: name.trim() && icon ? `0 4px 12px ${color}40` : 'none',
                        }}
                    >
                        {isEditing ? 'Save Changes' : 'Create Tile'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default CreateCustomTileModal;
