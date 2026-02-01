/**
 * Toggle Component
 *
 * A reusable toggle switch.
 */

import React from 'react';

import { styles } from '../PushNotificationSettings.styles';
import type { ToggleProps } from '../PushNotificationSettings.types';

export const Toggle: React.FC<ToggleProps> = ({ enabled, onChange, disabled }) => (
  <button
    type="button"
    onClick={() => !disabled && onChange(!enabled)}
    style={{
      ...styles.toggle,
      ...(enabled ? styles.toggleActive : {}),
      ...(disabled ? styles.toggleDisabled : {}),
    }}
    aria-pressed={enabled}
    disabled={disabled}
  >
    <span
      style={{
        ...styles.toggleKnob,
        ...(enabled ? styles.toggleKnobActive : {}),
      }}
    />
  </button>
);
