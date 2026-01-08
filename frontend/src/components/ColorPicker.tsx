/**
 * ColorPicker Component
 * 
 * A glassmorphism-styled color picker with preset colors and custom hex input.
 * Includes a "Reset to default" option for predefined activities.
 */

import React, { useState, useCallback } from 'react';
import { Check, RotateCcw } from 'lucide-react';

// Preset color palette matching app theme
export const PRESET_COLORS = [
    '#3b82f6', // Blue (default - matches app accent)
    '#0ea5e9', // Sky
    '#06b6d4', // Cyan
    '#10b981', // Emerald
    '#84cc16', // Lime
    '#f59e0b', // Amber
    '#f97316', // Orange
    '#ef4444', // Red
    '#f43f5e', // Rose
    '#ec4899', // Pink
    '#d946ef', // Fuchsia
    '#a855f7', // Purple
    '#8b5cf6', // Violet
    '#6366f1', // Indigo
    '#0f766e', // Teal
    '#64748b', // Slate
];

interface ColorPickerProps {
    value: string;
    onChange: (color: string) => void;
    defaultColor?: string;
    showResetButton?: boolean;
    onReset?: () => void;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
    value,
    onChange,
    defaultColor,
    showResetButton = false,
    onReset,
}) => {
    const [customColor, setCustomColor] = useState(value);
    const [showCustomInput, setShowCustomInput] = useState(false);

    const handlePresetClick = useCallback((color: string) => {
        onChange(color);
        setCustomColor(color);
    }, [onChange]);

    const handleCustomChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const newColor = e.target.value;
        setCustomColor(newColor);
        
        // Validate hex format
        if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(newColor)) {
            onChange(newColor);
        }
    }, [onChange]);

    const handleReset = useCallback(() => {
        if (defaultColor) {
            onChange(defaultColor);
            setCustomColor(defaultColor);
        }
        onReset?.();
    }, [defaultColor, onChange, onReset]);

    const isCustomColor = !PRESET_COLORS.includes(value);

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
        }}>
            {/* Preset Colors Grid */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(8, 1fr)',
                gap: '8px',
            }}>
                {PRESET_COLORS.map((color) => (
                    <button
                        key={color}
                        type="button"
                        onClick={() => handlePresetClick(color)}
                        style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: '8px',
                            backgroundColor: color,
                            border: value === color ? '3px solid var(--text-primary)' : '2px solid transparent',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'all 0.2s ease',
                            boxShadow: value === color 
                                ? `0 0 0 2px var(--bg-primary), 0 4px 12px ${color}50`
                                : `0 2px 8px ${color}30`,
                        }}
                        title={color}
                    >
                        {value === color && (
                            <Check size={16} color="white" strokeWidth={3} />
                        )}
                    </button>
                ))}
            </div>

            {/* Custom Color Section */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
            }}>
                {/* Custom Color Preview & Toggle */}
                <button
                    type="button"
                    onClick={() => setShowCustomInput(!showCustomInput)}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 12px',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        color: 'var(--text-secondary)',
                        fontSize: '0.85rem',
                    }}
                >
                    <div
                        style={{
                            width: '20px',
                            height: '20px',
                            borderRadius: '4px',
                            backgroundColor: value,
                            border: '1px solid var(--border)',
                        }}
                    />
                    {showCustomInput ? 'Hide' : 'Custom'}
                </button>

                {/* Custom Hex Input */}
                {showCustomInput && (
                    <input
                        type="text"
                        value={customColor}
                        onChange={handleCustomChange}
                        placeholder="#000000"
                        maxLength={7}
                        style={{
                            flex: 1,
                            padding: '8px 12px',
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border)',
                            borderRadius: '8px',
                            color: 'var(--text-primary)',
                            fontSize: '0.85rem',
                            fontFamily: 'monospace',
                            outline: 'none',
                        }}
                    />
                )}

                {/* Reset Button */}
                {showResetButton && defaultColor && value !== defaultColor && (
                    <button
                        type="button"
                        onClick={handleReset}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '8px 12px',
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border)',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            color: 'var(--text-secondary)',
                            fontSize: '0.85rem',
                            transition: 'all 0.2s ease',
                        }}
                        title="Reset to default color"
                    >
                        <RotateCcw size={14} />
                        Reset
                    </button>
                )}
            </div>

            {/* Current Color Display */}
            {isCustomColor && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    background: `linear-gradient(135deg, ${value}20 0%, ${value}10 100%)`,
                    border: `1px solid ${value}40`,
                    borderRadius: '8px',
                }}>
                    <div
                        style={{
                            width: '24px',
                            height: '24px',
                            borderRadius: '6px',
                            backgroundColor: value,
                            boxShadow: `0 2px 8px ${value}50`,
                        }}
                    />
                    <span style={{
                        color: 'var(--text-primary)',
                        fontSize: '0.85rem',
                        fontFamily: 'monospace',
                    }}>
                        {value}
                    </span>
                    <Check size={16} color={value} style={{ marginLeft: 'auto' }} />
                </div>
            )}
        </div>
    );
};

export default ColorPicker;
