/**
 * ColorPicker Component
 *
 * A glassmorphism-styled color picker with preset colors and custom hex input.
 * Includes a "Reset to default" option for predefined activities.
 */

import { Check, RotateCcw } from 'lucide-react';
import React, { useCallback, useState } from 'react';

import { PRESET_COLORS } from '../constants/colors';

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

  const handlePresetClick = useCallback(
    (color: string) => {
      onChange(color);
      setCustomColor(color);
    },
    [onChange]
  );

  const handleCustomChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newColor = e.target.value;
      setCustomColor(newColor);

      // Validate hex format
      if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(newColor)) {
        onChange(newColor);
      }
    },
    [onChange]
  );

  const handleReset = useCallback(() => {
    if (defaultColor) {
      onChange(defaultColor);
      setCustomColor(defaultColor);
    }
    onReset?.();
  }, [defaultColor, onChange, onReset]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      {/* Preset Colors Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(8, 1fr)',
          gap: '6px',
        }}
      >
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => handlePresetClick(color)}
            style={{
              width: '100%',
              aspectRatio: '1',
              borderRadius: '6px',
              backgroundColor: color,
              border: value === color ? '2px solid var(--text-primary)' : '2px solid transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s ease',
              boxShadow: value === color ? `0 0 0 2px var(--bg-primary)` : 'none',
            }}
            title={color}
          >
            {value === color && <Check size={14} color="white" strokeWidth={3} />}
          </button>
        ))}
      </div>

      {/* Custom Color Row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <button
          type="button"
          onClick={() => setShowCustomInput(!showCustomInput)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            cursor: 'pointer',
            color: 'var(--text-tertiary)',
            fontSize: '0.75rem',
          }}
        >
          <div
            style={{
              width: '16px',
              height: '16px',
              borderRadius: '3px',
              backgroundColor: value,
              border: '1px solid var(--border)',
            }}
          />
          {showCustomInput ? 'Hide' : 'Custom'}
        </button>

        {showCustomInput && (
          <input
            type="text"
            value={customColor}
            onChange={handleCustomChange}
            placeholder="#000000"
            maxLength={7}
            style={{
              flex: 1,
              padding: '6px 10px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              color: 'var(--text-primary)',
              fontSize: '0.8rem',
              fontFamily: 'monospace',
              outline: 'none',
            }}
          />
        )}

        {showResetButton && defaultColor && value !== defaultColor && (
          <button
            type="button"
            onClick={handleReset}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '6px 10px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              cursor: 'pointer',
              color: 'var(--text-tertiary)',
              fontSize: '0.75rem',
            }}
            title="Reset to default color"
          >
            <RotateCcw size={12} />
            Reset
          </button>
        )}
      </div>
    </div>
  );
};

export default ColorPicker;
