/**
 * Theme Picker Component
 *
 * Light / Dark / Auto choice shown as mini app previews (a radio group).
 */

import type { LucideIcon } from 'lucide-react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import React from 'react';

import { handleRovingKeyDown } from '../../../utils/rovingFocus';
import type { ThemePickerProps } from '../SettingsPage.types';
import styles from './ThemePicker.module.css';

interface ThemeOption {
  value: ThemePickerProps['value'];
  label: string;
  srHint?: string;
  icon: LucideIcon;
  previewClass: string;
}

const OPTIONS: ThemeOption[] = [
  { value: 'light', label: 'Light', icon: Sun, previewClass: styles.previewLight },
  { value: 'dark', label: 'Dark', icon: Moon, previewClass: styles.previewDark },
  {
    value: 'system',
    label: 'Auto',
    srHint: ', matches your device',
    icon: Monitor,
    previewClass: styles.previewAuto,
  },
];

export const ThemePicker: React.FC<ThemePickerProps> = ({ value, onChange }) => (
  <div className={styles.picker} role="radiogroup" aria-label="Theme">
    {OPTIONS.map((option, index) => {
      const selected = value === option.value;
      const Icon = option.icon;
      return (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={selected}
          tabIndex={selected ? 0 : -1}
          className={`${styles.option} ${selected ? styles.selected : ''}`}
          onClick={() => onChange(option.value)}
          onKeyDown={(e) => handleRovingKeyDown(e, index, (next) => onChange(OPTIONS[next].value))}
        >
          <span className={`${styles.preview} ${option.previewClass}`} aria-hidden="true">
            <span className={styles.previewBar}>
              <span className={styles.previewLogo} />
            </span>
            <span className={styles.previewTiles}>
              <span />
              <span />
              <span />
            </span>
            <span className={styles.previewProgress} />
            {selected && (
              <span className={styles.check}>
                <Check size={12} strokeWidth={3.2} />
              </span>
            )}
          </span>
          <span className={styles.label}>
            <Icon size={14} strokeWidth={2.4} aria-hidden="true" />
            {option.label}
            {option.srHint && <span className="sr-only">{option.srHint}</span>}
          </span>
        </button>
      );
    })}
  </div>
);
