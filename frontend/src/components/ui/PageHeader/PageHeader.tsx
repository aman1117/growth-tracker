/**
 * PageHeader Component
 *
 * Consistent in-page title bar used by every screen below the global app header.
 * - Tab-root screens (Home, Analytics, Settings) render a title only.
 * - Pushed screens (another user's profile / analytics) pass `onBack` to get a
 *   Back button, matching native navigation-bar conventions.
 *
 * @example
 * <PageHeader title="Analytics" />
 * <PageHeader title="@jane" onBack={goBack} actions={<IconButton ... />} />
 */

import { ArrowLeft } from 'lucide-react';
import type { FC, ReactNode } from 'react';

import { IconButton } from '../IconButton';
import styles from './PageHeader.module.css';

export interface PageHeaderProps {
  /** Screen title */
  title: ReactNode;
  /** When provided, a Back button is shown and invokes this handler */
  onBack?: () => void;
  /** Accessible label for the Back button */
  backLabel?: string;
  /** Optional trailing actions (icon buttons, menus) */
  actions?: ReactNode;
  /** Heading level used for the title (defaults to h1 — one per screen) */
  headingLevel?: 'h1' | 'h2';
  /** Additional CSS class */
  className?: string;
}

export const PageHeader: FC<PageHeaderProps> = ({
  title,
  onBack,
  backLabel = 'Go back',
  actions,
  headingLevel = 'h1',
  className,
}) => {
  const Heading = headingLevel;

  return (
    <div className={`${styles.pageHeader} ${className ?? ''}`}>
      {onBack && (
        <IconButton
          variant="ghost"
          size="md"
          icon={<ArrowLeft size={20} />}
          onClick={onBack}
          aria-label={backLabel}
          className={styles.backButton}
        />
      )}
      <Heading className={styles.title}>{title}</Heading>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
};

export default PageHeader;
