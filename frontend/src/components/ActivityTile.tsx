import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import type { ActivityName } from '../types';
import type { LucideIcon } from 'lucide-react';

export type TileSize = 'small' | 'medium' | 'wide';

interface ActivityTileProps {
    name: ActivityName;
    hours: number;
    onClick: () => void;
    icon: LucideIcon;
    color: string;
    isDraggable?: boolean;
    size?: TileSize;
    onResize?: (name: ActivityName, size: TileSize) => void;
    isSelected?: boolean;
    onSelect?: (name: ActivityName | null) => void;
    isOtherSelected?: boolean;
    isDragging?: boolean;
    hasNote?: boolean;
}

const sizeConfig = {
    small: { colSpan: 1, rowSpan: 1, iconSize: 20, fontSize: '0.65rem', hoursSize: '0.9rem', iconBg: 36 },
    medium: { colSpan: 2, rowSpan: 2, iconSize: 40, fontSize: '1rem', hoursSize: '1.75rem', iconBg: 70 },
    wide: { colSpan: 2, rowSpan: 1, iconSize: 24, fontSize: '0.75rem', hoursSize: '1.1rem', iconBg: 42 },
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
}) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transition,
    } = useSortable({ id: name, disabled: !isDraggable || !isSelected });

    // Don't apply transform - let DragOverlay handle the visual dragging
    const style = {
        transition,
        opacity: isDraggingProp ? 0.3 : 1,
        zIndex: isSelected ? 100 : 1,
    };

    const isActive = hours > 0;
    const config = sizeConfig[size];

    // Format name (e.g., book_reading -> Book Reading)
    const displayName = name.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    
    // Check if name is long (more than 10 chars) to reduce font size
    const isLongName = displayName.length > 10;
    const adjustedFontSize = isLongName && size === 'small' ? '0.55rem' : config.fontSize;

    const handleTileClick = (e: React.MouseEvent) => {
        if (isDraggingProp) return;
        
        if (isDraggable) {
            e.stopPropagation();
            if (isSelected) {
                // Already selected - cycle to next size
                onResize?.(name, getNextSize(size));
            } else {
                // Not selected - select it
                onSelect?.(name);
            }
        } else {
            onClick();
        }
    };

    return (
        <div
            ref={setNodeRef}
            style={{
                ...style,
                gridColumn: `span ${config.colSpan}`,
                gridRow: `span ${config.rowSpan}`,
                backgroundColor: isActive ? color : 'var(--bg-tertiary)',
                padding: size === 'small' ? '0.5rem' : size === 'wide' ? '0.75rem' : '1rem',
                cursor: isDraggingProp ? 'grabbing' : isDraggable ? 'pointer' : 'pointer',
                display: 'flex',
                flexDirection: size === 'wide' ? 'row' : 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: size === 'small' ? '0.25rem' : size === 'wide' ? '0.75rem' : '0.5rem',
                minHeight: size === 'small' ? '100px' : size === 'wide' ? '100px' : '208px',
                transition: isDraggingProp ? 'none' : 'all 0.15s ease',
                position: 'relative',
                borderRadius: '8px',
                // Only disable touch scrolling when tile is selected and ready to drag
                touchAction: isSelected && isDraggable ? 'none' : 'manipulation',
                overflow: 'hidden',
                border: isActive ? `1px solid ${color}` : '1px solid var(--border)',
                boxShadow: isActive ? `0 2px 8px ${color}40` : 'none',
                // Grey out when another tile is selected
                filter: isOtherSelected && !isSelected ? 'brightness(0.5) saturate(0.5)' : 'none',
                // Selection border
                outline: isSelected ? '3px solid var(--text-primary)' : 'none',
                outlineOffset: '-1px',
            }}
            className="activity-tile metro-tile"
            onClick={handleTileClick}
            {...(isSelected ? { ...attributes, ...listeners } : {})}
        >
            {/* Note Badge - simple dot indicator */}
            {hasNote && !isSelected && (
                <div
                    style={{
                        position: 'absolute',
                        top: size === 'small' ? '6px' : '10px',
                        right: size === 'small' ? '6px' : '10px',
                        width: size === 'small' ? '10px' : '12px',
                        height: size === 'small' ? '10px' : '12px',
                        borderRadius: '50%',
                        backgroundColor: isActive ? 'rgba(255,255,255,0.9)' : 'var(--accent)',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                        zIndex: 10,
                    }}
                    title="Has note"
                />
            )}

            {/* When selected: show only size label */}
            {isSelected && isDraggable ? (
                <span style={{
                    fontSize: size === 'medium' ? '1.2rem' : '0.75rem',
                    fontWeight: 700,
                    color: isActive ? 'white' : 'var(--text-primary)',
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                }}>
                    {size}
                </span>
            ) : (
                <>
                    {/* Icon */}
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: `${config.iconBg}px`,
                            height: `${config.iconBg}px`,
                            borderRadius: '50%',
                            backgroundColor: isActive ? 'rgba(255,255,255,0.2)' : 'var(--icon-bg-muted)',
                            flexShrink: 0,
                            transition: 'all 0.2s ease',
                        }}
                    >
                        <Icon
                            size={config.iconSize}
                            color={isActive ? 'white' : 'var(--text-secondary)'}
                            style={{ transition: 'color 0.2s' }}
                        />
                    </div>

                    {/* Content */}
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: size === 'wide' ? 'flex-start' : 'center',
                        gap: '0.125rem',
                        minWidth: 0,
                        maxWidth: '100%',
                    }}>
                        <span style={{
                            fontSize: adjustedFontSize,
                            textAlign: size === 'wide' ? 'left' : 'center',
                            fontWeight: 600,
                            color: isActive ? 'white' : 'var(--text-secondary)',
                            lineHeight: 1.2,
                            wordBreak: 'break-word',
                            maxWidth: '100%',
                        }}>
                            {displayName}
                        </span>
                        <span style={{
                            fontSize: config.hoursSize,
                            fontWeight: 700,
                            color: isActive ? 'rgba(255,255,255,0.9)' : 'var(--text-secondary)'
                        }}>
                            {hours}h
                        </span>
                    </div>
                </>
            )}
        </div>
    );
};