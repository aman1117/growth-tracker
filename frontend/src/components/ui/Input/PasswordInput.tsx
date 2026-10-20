/**
 * PasswordInput Component
 *
 * Input preconfigured for passwords: lock icon plus an accessible
 * show/hide toggle. Accepts every Input prop except `type` and `iconRight`.
 */

import { Eye, EyeOff, Lock } from 'lucide-react';
import { forwardRef, useState } from 'react';

import type { InputProps } from './Input';
import { Input } from './Input';
import styles from './PasswordInput.module.css';

export type PasswordInputProps = Omit<InputProps, 'type' | 'iconRight'>;

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ icon, ...props }, ref) => {
    const [visible, setVisible] = useState(false);

    return (
      <Input
        ref={ref}
        {...props}
        type={visible ? 'text' : 'password'}
        icon={icon ?? <Lock size={18} strokeWidth={2.25} aria-hidden="true" />}
        iconRight={
          <button
            type="button"
            className={styles.toggle}
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            disabled={props.disabled}
          >
            {visible ? (
              <EyeOff size={18} strokeWidth={2.25} aria-hidden="true" />
            ) : (
              <Eye size={18} strokeWidth={2.25} aria-hidden="true" />
            )}
          </button>
        }
      />
    );
  }
);

PasswordInput.displayName = 'PasswordInput';

export default PasswordInput;
