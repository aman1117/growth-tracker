/**
 * ActivityTile Component
 *
 * Activity tracking tile with glassmorphism design.
 * Supports drag-and-drop, resizing, and edit mode.
 */

import React, { Suspense, useMemo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { X, Pencil } from 'lucide-react';
import type { ActivityName } from '../../types';
import { isCustomTile } from '../../types';
import type { LucideIcon } from 'lucide-react';
import { DynamicIcon } from '../DynamicIcon';
import styles from './ActivityTile.module.css';

export type TileSize = 'small' | 'medium' | 'wide';

export interface ActivityTileProps {
  name: ActivityName;
  hours: number;
  onClick: () => void;
  icon?: LucideIcon;
  color: string;
  isDraggable?: boolean;
  size?: TileSize;
  onResize?: (name: ActivityName, size: TileSize) => void;
  isSelected?: boolean;
  onSelect?: (name: ActivityName | null) => void;
  isOtherSelected?: boolean;
  isDragging?: boolean;
  hasNote?: boolean;
  isEditMode?: boolean;
  onHide?: (name: ActivityName) => void;
  onEditCustomTile?: () => void;
  displayLabel?: string;
  tileIndex?: number;
  iconName?: string;
}

const sizeConfig = {
  small: { iconSize: 20 },
  medium: { iconSize: 40 },
  wide: { iconSize: 24 },
};

// Cycle through sizes: small -> wide -> medium -> small
const getNextSize = (current: TileSize): TileSize => {
  if (current === 'small') return 'wide';
  if (current === 'wide') return 'medium';
  return 'small';
};

export const ActivityTile: React.FC<ActivityTileProps> = ({
  name,
  hours,
  onClick,
  icon: Icon,
  color,
  isDraggable = false,
  size = 'small',
  onResize,
  isSelected = false,
  onSelect,
  isOtherSelected = false,
  isDragging: isDraggingProp = false,
  hasNote = false,
  isEditMode = false,
  onHide,
  onEditCustomTile,
  displayLabel,
  tileIndex = 0,
  iconName,
}) => {
  const { attributes, listeners, setNodeRef, transition } = useSortable({
    id: name,
    disabled: !isDraggable || !isSelected,
  });

  const isActive = hours > 0;
  const config = sizeConfig[size];

  // Use custom display label if provided, otherwise format from name
  const displayName = useMemo(() => {
    return (
      displayLabel ||
      name
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    );
  }, [displayLabel, name]);

  const isLongName = displayName.length > 10;
  const isCustom = isCustomTile(name);

  const handleTileClick = (e: React.MouseEvent) => {
    if (isDraggingProp) return;

    if (isDraggable) {
      e.stopPropagation();
      if (isSelected) {
        onResize?.(name, getNextSize(size));
      } else {
        onSelect?.(name);
      }
    } else {
      onClick();
    }
  };

  const handleHideClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onHide?.(name);
  };

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEditCustomTile?.();
  };

  // Build class names
  const tileClassName = [
    styles.tile,
    styles[size],
    isActive && styles.active,
    isSelected && styles.selected,
    isOtherSelected && !isSelected && styles.otherSelected,
    isDraggingProp && styles.dragging,
    isEditMode && !isSelected && !isDraggingProp && (tileIndex % 2 === 0 ? styles.editing : styles.editingAlt),
  ]
    .filter(Boolean)
    .join(' ');

  const iconContainerClassName = [
    styles.iconContainer,
    isActive ? styles.active : styles.inactive,
  ]
    .filter(Boolean)
    .join(' ');

  const labelClassName = [
    styles.label,
    isActive ? styles.active : styles.inactive,
    isLongName && size === 'small' && styles.long,
  ]
    .filter(Boolean)
    .join(' ');

  const hoursClassName = [
    styles.hours,
    isActive ? styles.active : styles.inactive,
  ]
    .filter(Boolean)
    .join(' ');

  // Dynamic styles that depend on the color prop
  const tileStyle: React.CSSProperties = {
    transition,
    touchAction: isSelected && isDraggable ? 'none' : 'manipulation',
    // Apply color gradient when active
    ...(isActive && {
      background: `linear-gradient(135deg, ${color}dd 0%, ${color}aa 100%)`,
      boxShadow: `var(--glass-panel-shadow), var(--glass-panel-glow), 0 4px 20px ${color}50`,
    }),
  };

  return (
    <div
      ref={setNodeRef}
      style={tileStyle}
      className={tileClassName}
      onClick={handleTileClick}
      {...(isSelected ? { ...attributes, ...listeners } : {})}
    >
      {/* Delete Badge */}
      {isEditMode && !isDraggingProp && onHide && (
        <button
          onClick={handleHideClick}
          className={`${styles.badge} ${styles.deleteBadge}`}
          title="Hide tile"
        >
          <X size={14} strokeWidth={3} />
        </button>
      )}

      {/* Edit Badge */}
      {isEditMode && !isDraggingProp && isCustom && onEditCustomTile && (
        <button
          onClick={handleEditClick}
          className={`${styles.badge} ${styles.editBadge}`}
          title="Edit tile"
        >
          <Pencil size={12} strokeWidth={2.5} />
        </button>
      )}

      {/* Note Indicator */}
      {hasNote && !isSelected && !isEditMode && (
        <div
          className={`${styles.noteIndicator} ${isActive ? styles.active : styles.inactive}`}
          title="Has note"
        />
      )}

      {/* Content */}
      {isSelected && isDraggable ? (
        <span className={`${styles.sizeLabel} ${isActive ? styles.active : styles.inactive}`}>
          {size}
        </span>
      ) : (
        <>
          {/* Icon */}
          <div className={iconContainerClassName}>
            {iconName ? (
              <Suspense
                fallback={
                  <div
                    style={{ width: config.iconSize, height: config.iconSize }}
                  />
                }
              >
                <DynamicIcon
                  name={iconName}
                  size={config.iconSize}
                  color={isActive ? 'white' : 'var(--text-secondary)'}
                />
              </Suspense>
            ) : Icon ? (
              <Icon
                size={config.iconSize}
                color={isActive ? 'white' : 'var(--text-secondary)'}
                style={{ transition: 'color 0.2s' }}
              />
            ) : null}
          </div>

          {/* Label and Hours */}
          <div className={styles.content}>
            <span className={labelClassName}>{displayName}</span>
            <span className={hoursClassName}>{hours}h</span>
          </div>
        </>
      )}
    </div>
  );
};

export default ActivityTile;
