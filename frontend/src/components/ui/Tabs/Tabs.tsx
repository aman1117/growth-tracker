/**
 * Tabs Component
 *
 * Horizontal tab navigation with glass-style active indicator.
 * Uses design tokens for consistent styling.
 */

import React, { useEffect, useRef, useState } from 'react';

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

/**
 * Index of the tab a navigation key moves focus to, following the WAI-ARIA tabs pattern:
 * Left/Right wrap around, Home/End jump to the ends, and disabled tabs are skipped.
 * Returns null for keys the tab list does not handle.
 */
const getKeyboardTarget = (tabs: Tab[], from: number, key: string): number | null => {
  const enabled = tabs.flatMap((tab, index) => (tab.disabled ? [] : [index]));
  if (enabled.length === 0) return null;

  switch (key) {
    case 'ArrowRight':
      return enabled.find((index) => index > from) ?? enabled[0];
    case 'ArrowLeft':
      return [...enabled].reverse().find((index) => index < from) ?? enabled[enabled.length - 1];
    case 'Home':
      return enabled[0];
    case 'End':
      return enabled[enabled.length - 1];
    default:
      return null;
  }
};

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

  // Roving tabindex: the list is one Tab stop, on the selected tab (or the first enabled one)
  const selectedIndex = tabs.findIndex((tab) => tab.id === activeTab && !tab.disabled);
  const tabStopIndex =
    selectedIndex !== -1 ? selectedIndex : tabs.findIndex((tab) => !tab.disabled);

  // Arrow keys and Home/End only move focus; Enter/Space (native button clicks) select
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = getKeyboardTarget(tabs, index, event.key);
    if (target === null) return;
    event.preventDefault();
    tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  };

  return (
    <div className={containerClasses} ref={tabsRef} role="tablist">
      {tabs.map((tab, index) => {
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
            tabIndex={index === tabStopIndex ? 0 : -1}
            className={tabClasses}
            onClick={() => !tab.disabled && onTabChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            disabled={tab.disabled}
          >
            {tab.icon && <span className={styles.icon}>{tab.icon}</span>}
            <span className={styles.label}>{tab.label}</span>
          </button>
        );
      })}
      {variant === 'underline' && <div className={styles.indicator} style={indicatorStyle} />}
    </div>
  );
};

export default Tabs;
