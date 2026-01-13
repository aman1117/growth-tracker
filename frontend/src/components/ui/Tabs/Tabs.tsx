/**
 * Tabs Component
 *
 * Horizontal tab navigation with glass-style active indicator.
 * Uses design tokens for consistent styling.
 */

import React, { useState, useRef, useEffect } from 'react';
import styles from './Tabs.module.css';

export interface Tab {
  /** Unique tab identifier */
  id: string;
  /** Tab label */
  label: string;
  /** Optional icon */
  icon?: React.ReactNode;
  /** Disabled state */
  disabled?: boolean;
}

export interface TabsProps {
  /** Array of tab definitions */
  tabs: Tab[];
  /** Currently active tab ID */
  activeTab: string;
  /** Callback when tab changes */
  onTabChange: (tabId: string) => void;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Full width tabs */
  fullWidth?: boolean;
  /** Visual variant */
  variant?: 'default' | 'pills' | 'underline';
  /** Custom className */
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  activeTab,
  onTabChange,
  size = 'md',
  fullWidth = false,
  variant = 'default',
  className = '',
}) => {
  const tabsRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({});

  // Update indicator position when active tab changes
  useEffect(() => {
    if (variant !== 'underline' || !tabsRef.current) return;

    const activeElement = tabsRef.current.querySelector(
      `[data-tab-id="${activeTab}"]`
    ) as HTMLButtonElement;

    if (activeElement) {
      setIndicatorStyle({
        width: `${activeElement.offsetWidth}px`,
        transform: `translateX(${activeElement.offsetLeft}px)`,
      });
    }
  }, [activeTab, variant, tabs]);

  const containerClasses = [
    styles.tabs,
    styles[size],
    styles[variant],
    fullWidth ? styles.fullWidth : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClasses} ref={tabsRef} role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const tabClasses = [
          styles.tab,
          isActive ? styles.active : '',
          tab.disabled ? styles.disabled : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-disabled={tab.disabled}
            className={tabClasses}
            onClick={() => !tab.disabled && onTabChange(tab.id)}
            disabled={tab.disabled}
          >
            {tab.icon && <span className={styles.icon}>{tab.icon}</span>}
            <span className={styles.label}>{tab.label}</span>
          </button>
        );
      })}
      {variant === 'underline' && (
        <div className={styles.indicator} style={indicatorStyle} />
      )}
    </div>
  );
};

export default Tabs;
