/**
 * Toggle Component
 *
 * Push settings switch — a thin adapter over the shared ui/Toggle.
 */

import React from 'react';

import { Toggle as SwitchToggle } from '../../ui';
import type { ToggleProps } from '../PushNotificationSettings.types';

export const Toggle: React.FC<ToggleProps> = ({
  enabled,
  onChange,
  disabled,
  busy,
  id,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}) => (
  <SwitchToggle
    id={id}
    checked={enabled}
    onChange={onChange}
    disabled={disabled}
    busy={busy}
    size="sm"
    aria-labelledby={ariaLabelledBy}
    aria-describedby={ariaDescribedBy}
  />
);
