/**
 * Notice Component
 *
 * Compact floating status card for app-level messages (offline, email verification,
 * app updates…). Pair with <NoticeStack> so several notices stack neatly under the
 * header instead of overlapping each other or the navigation.
 *
 * @example
 * <NoticeStack>
 *   <Notice tone="warning" icon={<WifiOff />} title="You're offline" onDismiss={hide} />
 * </NoticeStack>
 */

import { X } from 'lucide-react';
import type { FC, ReactNode } from 'react';

import styles from './Notice.module.css';

export type NoticeTone = 'brand' | 'info' | 'success' | 'warning' | 'danger';

export interface NoticeAction {
  /** Button label */
  label: ReactNode;
  /** Click handler */
  onClick: () => void;
  /** Disables the action (e.g. during cooldown) */
  disabled?: boolean;
  /** Optional leading icon */
  icon?: ReactNode;
}

export interface NoticeProps {
  /** Color treatment of the icon chip and accent edge */
  tone?: NoticeTone;
  /** Leading icon (rendered inside a tinted chip) */
  icon?: ReactNode;
  /** Primary message */
  title: ReactNode;
  /** Optional secondary line */
  description?: ReactNode;
  /** Optional call to action */
  action?: NoticeAction;
  /** Shows a dismiss button when provided */
  onDismiss?: () => void;
  /** Accessible label for the dismiss button */
  dismissLabel?: string;
  /** Plays the exit animation (parent unmounts afterwards) */
  leaving?: boolean;
  /** `alert` for urgent problems, `status` for everything else */
  role?: 'status' | 'alert';
  /** Additional CSS class */
  className?: string;
}

export const Notice: FC<NoticeProps> = ({
  tone = 'brand',
  icon,
  title,
  description,
  action,
  onDismiss,
  dismissLabel = 'Dismiss',
  leaving = false,
  role = 'status',
  className,
}) => {
  const classNames = [styles.notice, styles[tone], leaving && styles.leaving, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classNames} role={role}>
      {icon && (
        <span className={styles.iconChip} aria-hidden="true">
          {icon}
        </span>
      )}

      <div className={styles.text}>
        <p className={styles.title}>{title}</p>
        {description && <p className={styles.description}>{description}</p>}
      </div>

      {action && (
        <button
          type="button"
          className={styles.action}
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.icon}
          {action.label}
        </button>
      )}

      {onDismiss && (
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label={dismissLabel}
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
};

/** Fixed, pointer-transparent column that stacks notices below the app header */
export const NoticeStack: FC<{ children: ReactNode }> = ({ children }) => (
  <div className={styles.stack} aria-live="polite">
    {children}
  </div>
);

export default Notice;
