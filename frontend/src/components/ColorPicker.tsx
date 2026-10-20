/**
 * ColorPicker Component
 *
 * Swatch palette with a custom color option (native picker + hex field).
 * Includes an optional "Reset to default" action for predefined activities.
 * Keyboard: one Tab stop for the palette, arrow keys move the selection.
 */

import { Check, Pipette, RotateCcw } from 'lucide-react';
import React, { useCallback, useEffect, useId, useState } from 'react';

import { PRESET_COLOR_OPTIONS } from '../constants/colors';
import { getOnColorTone } from '../utils/color';
import { handleRovingKeyDown } from '../utils/rovingFocus';
import styles from './ColorPicker.module.css';

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  defaultColor?: string;
  showResetButton?: boolean;
  onReset?: () => void;
}

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#AbC" → "#aabbcc" so stored colors are always 6-digit lowercase hex */
const normalizeHex = (hex: string): string => {
  const value = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return value;
};

const isSameColor = (a: string, b: string) => normalizeHex(a) === normalizeHex(b);

export const ColorPicker: React.FC<ColorPickerProps> = ({
  value,
  onChange,
  defaultColor,
  showResetButton = false,
  onReset,
}) => {
  const isPreset = PRESET_COLOR_OPTIONS.some((option) => isSameColor(option.value, value));
  const selectedIndex = PRESET_COLOR_OPTIONS.findIndex((option) =>
    isSameColor(option.value, value)
  );
  const [customColor, setCustomColor] = useState(value);
  // Editing a tile that already uses a custom color opens the custom row
  const [showCustomInput, setShowCustomInput] = useState(!isPreset);
  const customRegionId = useId();

  // Follow external changes without clobbering a short hex the user is typing ("#abc")
  useEffect(() => {
    setCustomColor((previous) => (isSameColor(previous, value) ? previous : value));
  }, [value]);

  const handlePresetClick = useCallback(
    (color: string) => {
      onChange(color);
      setCustomColor(color);
    },
    [onChange]
  );

  const handleCustomChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value.trim();
      const newColor = raw && !raw.startsWith('#') ? `#${raw}` : raw;
      setCustomColor(newColor);

      // Validate hex format
      if (HEX_PATTERN.test(newColor)) {
        onChange(normalizeHex(newColor));
      }
    },
    [onChange]
  );

  const handleNativeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newColor = normalizeHex(e.target.value);
      setCustomColor(newColor);
      onChange(newColor);
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

  const isCustomValid = HEX_PATTERN.test(customColor);
  const nativeValue = HEX_PATTERN.test(value) ? normalizeHex(value) : '#000000';
  const valueTone = getOnColorTone(nativeValue);

  return (
    <div className={styles.picker}>
      {/* Preset Colors */}
      <div className={styles.swatches} role="radiogroup" aria-label="Preset colors">
        {PRESET_COLOR_OPTIONS.map((option, index) => {
          const selected = index === selectedIndex;
          // Roving tab stop: the selected swatch, or the first one when a custom color is used
          const isTabStop = selectedIndex === -1 ? index === 0 : selected;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.name}
              title={option.name}
              tabIndex={isTabStop ? 0 : -1}
              className={`${styles.swatch} ${selected ? styles.swatchSelected : ''}`}
              style={{ '--swatch': option.value } as React.CSSProperties}
              onClick={() => handlePresetClick(option.value)}
              onKeyDown={(e) =>
                handleRovingKeyDown(e, index, (next) =>
                  handlePresetClick(PRESET_COLOR_OPTIONS[next].value)
                )
              }
            >
              {selected && (
                <Check
                  size={15}
                  strokeWidth={3}
                  aria-hidden="true"
                  className={
                    getOnColorTone(option.value) === 'light' ? styles.checkLight : styles.checkDark
                  }
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Custom Color + Reset */}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.chip} ${!isPreset ? styles.chipActive : ''}`}
          onClick={() => setShowCustomInput((open) => !open)}
          aria-expanded={showCustomInput}
          aria-controls={customRegionId}
        >
          <span
            className={styles.chipSwatch}
            style={{ '--swatch': nativeValue } as React.CSSProperties}
            aria-hidden="true"
          />
          {showCustomInput ? 'Hide custom' : 'Custom color'}
        </button>

        {showResetButton && defaultColor && !isSameColor(value, defaultColor) && (
          <button
            type="button"
            className={styles.chip}
            onClick={handleReset}
            title="Reset to default color"
          >
            <RotateCcw size={13} strokeWidth={2.5} aria-hidden="true" />
            Reset
          </button>
        )}
      </div>

      {showCustomInput && (
        <div id={customRegionId} className={styles.customRow}>
          <label
            className={styles.nativePicker}
            style={{ '--swatch': nativeValue } as React.CSSProperties}
            title="Pick any color"
          >
            <input type="color" value={nativeValue} onChange={handleNativeChange} />
            <Pipette
              size={16}
              strokeWidth={2.25}
              aria-hidden="true"
              className={valueTone === 'light' ? styles.checkLight : styles.checkDark}
            />
            <span className="sr-only">Pick a custom color</span>
          </label>
          <div className={`${styles.hexField} ${!isCustomValid ? styles.hexFieldInvalid : ''}`}>
            <span className={styles.hexPrefix} aria-hidden="true">
              HEX
            </span>
            <input
              type="text"
              value={customColor}
              onChange={handleCustomChange}
              placeholder="#8b5cf6"
              maxLength={7}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-label="Hex color code"
              aria-invalid={!isCustomValid || undefined}
              className={styles.hexInput}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default ColorPicker;
