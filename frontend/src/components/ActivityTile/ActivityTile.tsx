/**
 * ActivityTile Component
 *
 * One activity on the home grid.
 * - Empty (0h): calm glass tile with an icon chip tinted in the activity color.
 * - Logged (>0h): rich gradient in the activity color; text/icon tone is picked
 *   from the color's contrast (white on deep colors, ink on bright ones).
 * Supports drag-and-drop, resizing and edit mode.
 */

import { useSortable } from '@dnd-kit/sortable';
import type { LucideIcon } from 'lucide-react';
import { Pencil, X } from 'lucide-react';
import React, { Suspense, useMemo } from 'react';

import type { ActivityName } from '../../types';
import { isCustomTile } from '../../types';
import { getOnColorTone } from '../../utils/color';
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

const ICON_SIZES: Record<TileSize, number> = {
  small: 20,
  medium: 34,
  wide: 24,
};

const SIZE_LABELS: Record<TileSize, string> = {
  small: 'Small',
  wide: 'Wide',
  medium: 'Large',
};

// Cycle through sizes: small -> wide -> medium -> small
const getNextSize = (current: TileSize): TileSize => {
  if (current === 'small') return 'wide';
  if (current === 'wide') return 'medium';
  return 'small';
};

/** "deep_work" → "Deep Work" */
const formatActivityName = (name: string) =>
  name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

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
  const iconSize = ICON_SIZES[size];
  const displayName = useMemo(() => displayLabel || formatActivityName(name), [displayLabel, name]);
  const onColorTone = useMemo(() => getOnColorTone(color), [color]);

  const isLongName = displayName.length > 10;
  const isCustom = isCustomTile(name);
  const showSizeLabel = isSelected && isDraggable;

  const activate = () => {
    if (isDraggingProp) return;

    if (isDraggable) {
      if (isSelected) {
        onResize?.(name, getNextSize(size));
      } else {
        onSelect?.(name);
      }
    } else {
      onClick();
    }
  };

  const handleTileClick = (e: React.MouseEvent) => {
    if (isDraggable) e.stopPropagation();
    activate();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
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

  const cellClassName = [
    styles.cell,
    styles[size],
    isSelected && styles.selected,
    isOtherSelected && !isSelected && styles.otherSelected,
    isDraggingProp && styles.dragging,
    isEditMode &&
      !isSelected &&
      !isDraggingProp &&
      (tileIndex % 2 === 0 ? styles.editing : styles.editingAlt),
  ]
    .filter(Boolean)
    .join(' ');

  const tileClassName = [
    styles.tile,
    isActive && styles.active,
    isActive && (onColorTone === 'light' ? styles.onLight : styles.onDark),
  ]
    .filter(Boolean)
    .join(' ');

  const cellStyle = {
    '--tile-color': color,
    transition,
    touchAction: isSelected && isDraggable ? 'none' : 'manipulation',
  } as React.CSSProperties;

  const hoursLabel = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const ariaLabel = isDraggable
    ? `${displayName}, ${SIZE_LABELS[size].toLowerCase()} tile${
        isSelected ? ', selected. Activate to resize' : '. Activate to select'
      }`
    : `${displayName}, ${hoursLabel}${hasNote ? ', has note' : ''}`;

  // dnd-kit wiring only while selected (edit mode); our a11y props are set after the spread
  const dndProps = isSelected ? { ...attributes, ...listeners } : undefined;

  const handleTileKeyDown = (e: React.KeyboardEvent) => {
    // A selected tile hands keyboard control to dnd-kit (Space/Enter picks it up)
    const dndKeyDown = isSelected ? listeners?.onKeyDown : undefined;
    if (dndKeyDown) {
      dndKeyDown(e);
      return;
    }
    handleKeyDown(e);
  };

  return (
    <div ref={setNodeRef} style={cellStyle} className={cellClassName}>
      <div
        {...dndProps}
        className={tileClassName}
        onClick={handleTileClick}
        onKeyDown={handleTileKeyDown}
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-pressed={isDraggable ? isSelected : undefined}
      >
        {/* Note indicator */}
        {hasNote && !isSelected && !isEditMode && (
          <span className={styles.noteDot} title="Has note" aria-hidden="true" />
        )}

        {showSizeLabel ? (
          <div className={styles.sizeInfo}>
            <span className={styles.sizeLabel}>{SIZE_LABELS[size]}</span>
            {size !== 'small' && <span className={styles.sizeHint}>Tap to resize · drag</span>}
          </div>
        ) : (
          <>
            <div className={styles.iconChip} aria-hidden="true">
              {iconName ? (
                <Suspense fallback={<span style={{ width: iconSize, height: iconSize }} />}>
                  <DynamicIcon name={iconName} size={iconSize} color="currentColor" />
                </Suspense>
              ) : Icon ? (
                <Icon size={iconSize} color="currentColor" strokeWidth={2.1} />
              ) : null}
            </div>

            <div className={styles.content}>
              <span
                className={`${styles.label} ${isLongName && size === 'small' ? styles.long : ''}`}
              >
                {displayName}
              </span>
              <span className={styles.hours}>
                {hours}
                <span className={styles.hoursUnit}>h</span>
              </span>
            </div>
          </>
        )}
      </div>

      {/* Hide badge (edit mode) - sibling of the tile so buttons never nest */}
      {isEditMode && !isDraggingProp && onHide && (
        <button
          type="button"
          onClick={handleHideClick}
          className={`${styles.badge} ${styles.deleteBadge}`}
          title="Hide tile"
          aria-label={`Hide ${displayName}`}
        >
          <X size={13} strokeWidth={3} aria-hidden="true" />
        </button>
      )}

      {/* Edit badge (custom tiles in edit mode) */}
      {isEditMode && !isDraggingProp && isCustom && onEditCustomTile && (
        <button
          type="button"
          onClick={handleEditClick}
          className={`${styles.badge} ${styles.editBadge}`}
          title="Edit tile"
          aria-label={`Edit ${displayName}`}
        >
          <Pencil size={12} strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
    </div>
  );
};

export default ActivityTile;
