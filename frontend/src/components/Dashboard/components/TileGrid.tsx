/**
 * TileGrid Component
 *
 * Renders the draggable activity tiles grid with DnD support.
 */

import {
  closestCenter,
  DndContext,
  DragOverlay,
} from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import React from 'react';

import { createCustomActivityName, getActivityConfig } from '../../../constants';
import type { ActivityName, CustomTile } from '../../../types';
import { isCustomTile, MAX_CUSTOM_TILES } from '../../../types';
import type { TileSize } from '../../ActivityTile';
import { ActivityTile } from '../../ActivityTile';

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
  return (
    <>
      <style>{`
        @keyframes slideOutLeft {
          from { opacity: 1; transform: translateX(0); }
          to { opacity: 0; transform: translateX(-20px); }
        }
        @keyframes slideOutRight {
          from { opacity: 1; transform: translateX(0); }
          to { opacity: 0; transform: translateX(20px); }
        }
        @keyframes slideInLeft {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(-20px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .tiles-slide-out-left {
          animation: slideOutLeft 0.15s ease-out forwards;
        }
        .tiles-slide-out-right {
          animation: slideOutRight 0.15s ease-out forwards;
        }
        .tiles-slide-in-left {
          animation: slideInLeft 0.25s ease-out forwards;
        }
        .tiles-slide-in-right {
          animation: slideInRight 0.25s ease-out forwards;
        }
      `}</style>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={visibleTiles} strategy={rectSortingStrategy}>
          <div
            className={
              tilesAnimating
                ? animationDirection === 'left'
                  ? 'tiles-slide-out-left'
                  : 'tiles-slide-out-right'
                : animationDirection === 'left'
                  ? 'tiles-slide-in-left'
                  : 'tiles-slide-in-right'
            }
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gridAutoRows: '100px',
              gap: '8px',
              padding: '8px',
            }}
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
                  onEditCustomTile={
                    customTile
                      ? () => onEditCustomTile(customTile)
                      : undefined
                  }
                  displayLabel={config.label}
                  tileIndex={index}
                  iconName={config.iconName}
                />
              );
            })}

            {/* Add Custom Tile Button - show in edit mode when under limit */}
            {isEditMode && !isReadOnly && customTiles.length < MAX_CUSTOM_TILES && (
              <div
                onClick={onAddCustomTile}
                style={{
                  gridColumn: 'span 1',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  background: 'var(--tile-glass-bg)',
                  backdropFilter: 'blur(var(--tile-glass-blur))',
                  WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
                  borderRadius: '24px',
                  border: '2px dashed var(--border)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#0095f6';
                  e.currentTarget.style.background = 'rgba(0, 149, 246, 0.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border)';
                  e.currentTarget.style.background = 'var(--tile-glass-bg)';
                }}
              >
                <Plus size={24} style={{ color: '#0095f6' }} />
                <span
                  style={{
                    fontSize: '0.65rem',
                    color: 'var(--text-secondary)',
                    textAlign: 'center',
                    padding: '0 4px',
                  }}
                >
                  Add Tile
                </span>
              </div>
            )}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeDragId
            ? (() => {
                const dragConfig = getActivityConfig(activeDragId, customTiles, tileColors);
                return (
                  <div
                    style={{
                      backgroundColor: dragConfig.color || 'var(--bg-tertiary)',
                      padding: '1rem',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: tileSizes[activeDragId] === 'small' ? '100px' : '208px',
                      minHeight: tileSizes[activeDragId] === 'medium' ? '208px' : '100px',
                      opacity: 0.9,
                      boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                      border: '3px solid var(--text-primary)',
                      borderRadius: '8px',
                    }}
                  >
                    <span
                      style={{
                        fontSize: tileSizes[activeDragId] === 'medium' ? '1.2rem' : '0.75rem',
                        fontWeight: 700,
                        color: 'white',
                        textTransform: 'uppercase',
                        letterSpacing: '1px',
                      }}
                    >
                      {tileSizes[activeDragId]}
                    </span>
                  </div>
                );
              })()
            : null}
        </DragOverlay>
      </DndContext>
    </>
  );
};
