/**
 * TileGrid Component
 *
 * Renders the draggable activity tiles grid with DnD support.
 */

import { closestCenter, DndContext, DragOverlay } from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import React from 'react';

import { createCustomActivityName, getActivityConfig } from '../../../constants';
import type { ActivityName, CustomTile } from '../../../types';
import { isCustomTile, MAX_CUSTOM_TILES } from '../../../types';
import { getOnColor } from '../../../utils/color';
import type { TileSize } from '../../ActivityTile';
import { ActivityTile } from '../../ActivityTile';
import styles from './TileGrid.module.css';

interface TileGridProps {
  visibleTiles: ActivityName[];
  activities: Record<string, number>;
  activityNotes: Record<string, string>;
  customTiles: CustomTile[];
  tileColors: Record<string, string>;
  tileSizes: Record<ActivityName, TileSize>;
  isEditMode: boolean;
  isReadOnly: boolean;
  selectedTile: ActivityName | null;
  activeDragId: ActivityName | null;
  tilesAnimating: boolean;
  animationDirection: 'left' | 'right';
  sensors: ReturnType<typeof import('@dnd-kit/core').useSensors>;
  onDragStart: (event: import('@dnd-kit/core').DragStartEvent) => void;
  onDragEnd: (event: import('@dnd-kit/core').DragEndEvent) => void;
  onActivityClick: (name: ActivityName) => void;
  onTileResize: (name: ActivityName, size: TileSize) => void;
  onSelectTile: (name: ActivityName | null) => void;
  onHideTile: (name: ActivityName) => void;
  onEditCustomTile: (tile: CustomTile) => void;
  onAddCustomTile: () => void;
}

const SLIDE_CLASSES = {
  out: { left: styles.slideOutLeft, right: styles.slideOutRight },
  in: { left: styles.slideInLeft, right: styles.slideInRight },
};

export const TileGrid: React.FC<TileGridProps> = ({
  visibleTiles,
  activities,
  activityNotes,
  customTiles,
  tileColors,
  tileSizes,
  isEditMode,
  isReadOnly,
  selectedTile,
  activeDragId,
  tilesAnimating,
  animationDirection,
  sensors,
  onDragStart,
  onDragEnd,
  onActivityClick,
  onTileResize,
  onSelectTile,
  onHideTile,
  onEditCustomTile,
  onAddCustomTile,
}) => {
  const slideClass = SLIDE_CLASSES[tilesAnimating ? 'out' : 'in'][animationDirection];
  const dragConfig = activeDragId ? getActivityConfig(activeDragId, customTiles, tileColors) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={visibleTiles} strategy={rectSortingStrategy}>
        <div
          className={`${styles.grid} ${slideClass}`}
          onClick={() => {
            if (isEditMode && selectedTile) {
              onSelectTile(null);
            }
          }}
        >
          {visibleTiles.map((name, index) => {
            const config = getActivityConfig(name, customTiles, tileColors);
            // For custom tiles, icon is a string (handled by iconName prop)
            const iconComponent = typeof config.icon === 'string' ? undefined : config.icon;
            // Find the custom tile object if this is a custom tile (for editing)
            const customTile = isCustomTile(name)
              ? customTiles.find((t) => createCustomActivityName(t.id) === name)
              : undefined;
            return (
              <ActivityTile
                key={name}
                name={name}
                hours={activities[name] || 0}
                onClick={() => onActivityClick(name)}
                icon={iconComponent}
                color={config.color}
                isDraggable={isEditMode && !isReadOnly}
                size={tileSizes[name]}
                onResize={onTileResize}
                isSelected={selectedTile === name}
                onSelect={onSelectTile}
                isOtherSelected={selectedTile !== null && selectedTile !== name}
                isDragging={activeDragId === name}
                hasNote={!isReadOnly && !!activityNotes[name]}
                isEditMode={isEditMode}
                onHide={onHideTile}
                onEditCustomTile={customTile ? () => onEditCustomTile(customTile) : undefined}
                displayLabel={config.label}
                tileIndex={index}
                iconName={config.iconName}
              />
            );
          })}

          {/* Add Custom Tile Button - show in edit mode when under limit */}
          {isEditMode && !isReadOnly && customTiles.length < MAX_CUSTOM_TILES && (
            <button
              type="button"
              className={styles.addTile}
              onClick={(e) => {
                e.stopPropagation();
                onAddCustomTile();
              }}
              aria-label="Add a custom tile"
            >
              <span className={styles.addIcon} aria-hidden="true">
                <Plus size={20} strokeWidth={2.5} />
              </span>
              <span className={styles.addLabel}>Add Tile</span>
            </button>
          )}
        </div>
      </SortableContext>

      <DragOverlay>
        {activeDragId && dragConfig ? (
          <div
            className={styles.dragOverlay}
            style={
              {
                '--tile-color': dragConfig.color,
                color: getOnColor(dragConfig.color),
              } as React.CSSProperties
            }
          >
            <span className={styles.dragLabel}>{dragConfig.label}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};
