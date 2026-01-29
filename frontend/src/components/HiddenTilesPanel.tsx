/**
 * HiddenTilesPanel Component
 *
 * A slide-up panel showing all hidden tiles with restore functionality.
 * Supports both predefined and custom tiles.
 * Also shows orphaned custom tiles (tiles in DB but not in order/hidden).
 * Glassmorphism styled to match app theme.
 */

import type { LucideIcon } from 'lucide-react';
import { AlertCircle, AlertTriangle, EyeOff, Pencil, Plus, Trash2, X } from 'lucide-react';
import React, { useCallback, useState } from 'react';

import { createCustomActivityName, getActivityConfig } from '../constants/activities';
import type { ActivityName, CustomTile, PredefinedActivityName } from '../types';
import { isCustomTile } from '../types';
import { DynamicIcon } from './DynamicIcon';

interface HiddenTilesPanelProps {
  isOpen: boolean;
  onClose: () => void;
  hiddenTiles: ActivityName[];
  customTiles: CustomTile[];
  tileOrder: ActivityName[];
  colorOverrides?: Record<string, string>;
  onRestoreTile: (tileName: ActivityName) => void;
  onDeleteCustomTile?: (tileId: string) => void;
  onEditCustomTile?: (tile: CustomTile) => void;
}

export const HiddenTilesPanel: React.FC<HiddenTilesPanelProps> = ({
  isOpen,
  onClose,
  hiddenTiles,
  customTiles,
  tileOrder,
  colorOverrides,
  onRestoreTile,
  onDeleteCustomTile,
  onEditCustomTile,
}) => {
  const handleRestore = useCallback(
    (tileName: ActivityName) => {
      onRestoreTile(tileName);
    },
    [onRestoreTile]
  );

  // State for delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<{ tileId: string; tileName: string } | null>(
    null
  );

  const handleDeleteClick = useCallback((tileId: string, tileName: string) => {
    setDeleteConfirm({ tileId, tileName });
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (deleteConfirm) {
      onDeleteCustomTile?.(deleteConfirm.tileId);
      setDeleteConfirm(null);
    }
  }, [deleteConfirm, onDeleteCustomTile]);

  const handleCancelDelete = useCallback(() => {
    setDeleteConfirm(null);
  }, []);

  if (!isOpen) return null;

  // Separate hidden predefined and custom tiles
  const hiddenPredefined = hiddenTiles.filter((t) => !isCustomTile(t)) as PredefinedActivityName[];
  const hiddenCustom = hiddenTiles.filter((t) => isCustomTile(t));

  // Find orphaned custom tiles (exist in customTiles but not in order or hidden)
  const orphanedCustomTiles = customTiles.filter((tile) => {
    const activityName = createCustomActivityName(tile.id);
    return !tileOrder.includes(activityName) && !hiddenTiles.includes(activityName);
  });

  // Check if there's any content to show
  const hasContent = hiddenTiles.length > 0 || orphanedCustomTiles.length > 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
        }}
      />

      {/* Panel */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '500px',
          maxHeight: '70vh',
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRadius: '24px 24px 0 0',
          border: '1px solid var(--border)',
          borderBottom: 'none',
          boxShadow: '0 -10px 40px rgba(0, 0, 0, 0.3)',
          animation: 'slideUpPanel 0.3s ease-out',
          overflow: 'hidden',
        }}
      >
        <style>{`
                    @keyframes slideUpPanel {
                        from {
                            transform: translateY(100%);
                            opacity: 0;
                        }
                        to {
                            transform: translateY(0);
                            opacity: 1;
                        }
                    }
                `}</style>

        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: '1rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            Manage Tiles
          </h2>
          <button
            onClick={onClose}
            style={{
              padding: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            padding: '16px 24px 24px',
            maxHeight: 'calc(70vh - 100px)',
            overflowY: 'auto',
          }}
        >
          {!hasContent ? (
            <div
              style={{
                textAlign: 'center',
                padding: '40px 20px',
                color: 'var(--text-tertiary)',
              }}
            >
              <EyeOff size={48} style={{ opacity: 0.3, marginBottom: '16px' }} />
              <p style={{ margin: 0, fontSize: '0.9rem' }}>No hidden or orphaned tiles</p>
              <p style={{ margin: '8px 0 0', fontSize: '0.8rem' }}>
                Tap the X on any tile in edit mode to hide it
              </p>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              {/* Predefined Tiles Section */}
              {hiddenPredefined.length > 0 && (
                <>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: 'var(--text-tertiary)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      marginBottom: '4px',
                      marginTop: '8px',
                    }}
                  >
                    Default Tiles
                  </div>
                  {hiddenPredefined.map((tileName) => {
                    const config = getActivityConfig(tileName, customTiles, colorOverrides);
                    const IconComponent = config.icon as LucideIcon;

                    return (
                      <div
                        key={tileName}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          padding: '12px 16px',
                          background: 'var(--bg-secondary)',
                          borderRadius: '12px',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <div
                          style={{
                            width: '40px',
                            height: '40px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: `${config.color}20`,
                            borderRadius: '10px',
                          }}
                        >
                          <IconComponent size={20} color={config.color} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              fontSize: '0.9rem',
                              fontWeight: 500,
                              color: 'var(--text-primary)',
                            }}
                          >
                            {config.label}
                          </div>
                        </div>
                        <button
                          onClick={() => handleRestore(tileName)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '8px 12px',
                            background: `${config.color}15`,
                            border: `1px solid ${config.color}30`,
                            borderRadius: '8px',
                            color: config.color,
                            fontSize: '0.8rem',
                            fontWeight: 500,
                            cursor: 'pointer',
                          }}
                        >
                          <Plus size={14} />
                          Restore
                        </button>
                      </div>
                    );
                  })}
                </>
              )}

              {/* Custom Tiles Section */}
              {hiddenCustom.length > 0 && (
                <>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: 'var(--text-tertiary)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      marginBottom: '4px',
                      marginTop: hiddenPredefined.length > 0 ? '16px' : '8px',
                    }}
                  >
                    Custom Tiles
                  </div>
                  {hiddenCustom.map((tileName) => {
                    const config = getActivityConfig(tileName, customTiles, colorOverrides);
                    const tileId = tileName.replace('custom:', '');
                    // Find the custom tile object for editing
                    const customTileObj = customTiles.find((t) => t.id === tileId);

                    return (
                      <div
                        key={tileName}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          padding: '12px 16px',
                          background: 'var(--bg-secondary)',
                          borderRadius: '12px',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <div
                          style={{
                            width: '40px',
                            height: '40px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: `${config.color}20`,
                            borderRadius: '10px',
                          }}
                        >
                          <DynamicIcon
                            name={config.icon as string}
                            size={20}
                            color={config.color}
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              fontSize: '0.9rem',
                              fontWeight: 500,
                              color: 'var(--text-primary)',
                            }}
                          >
                            {config.label}
                          </div>
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--text-tertiary)',
                            }}
                          >
                            Custom tile
                          </div>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            gap: '8px',
                          }}
                        >
                          <button
                            onClick={() => handleRestore(tileName)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              padding: '8px 12px',
                              background: `${config.color}15`,
                              border: `1px solid ${config.color}30`,
                              borderRadius: '8px',
                              color: config.color,
                              fontSize: '0.8rem',
                              fontWeight: 500,
                              cursor: 'pointer',
                            }}
                          >
                            <Plus size={14} />
                            Restore
                          </button>
                          {onEditCustomTile && customTileObj && (
                            <button
                              onClick={() => onEditCustomTile(customTileObj)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '36px',
                                height: '36px',
                                background: 'rgba(0, 149, 246, 0.1)',
                                border: '1px solid rgba(0, 149, 246, 0.3)',
                                borderRadius: '8px',
                                color: '#0095f6',
                                cursor: 'pointer',
                              }}
                              title="Edit tile"
                            >
                              <Pencil size={16} />
                            </button>
                          )}
                          {onDeleteCustomTile && (
                            <button
                              onClick={() => handleDeleteClick(tileId, config.label)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '36px',
                                height: '36px',
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                borderRadius: '8px',
                                color: '#ef4444',
                                cursor: 'pointer',
                              }}
                              title="Delete permanently"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}

              {/* Orphaned Custom Tiles Section */}
              {orphanedCustomTiles.length > 0 && (
                <>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: '#f59e0b',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      marginBottom: '4px',
                      marginTop:
                        hiddenPredefined.length > 0 || hiddenCustom.length > 0 ? '16px' : '8px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <AlertCircle size={14} />
                    Orphaned Tiles
                  </div>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--text-tertiary)',
                      marginBottom: '12px',
                      lineHeight: 1.4,
                    }}
                  >
                    These tiles exist in the database but are not visible on your dashboard. You can
                    restore or delete them.
                  </div>
                  {orphanedCustomTiles.map((tile) => {
                    const activityName = createCustomActivityName(tile.id);

                    return (
                      <div
                        key={tile.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          padding: '12px 16px',
                          background: 'rgba(245, 158, 11, 0.08)',
                          borderRadius: '12px',
                          border: '1px solid rgba(245, 158, 11, 0.2)',
                        }}
                      >
                        <div
                          style={{
                            width: '40px',
                            height: '40px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: `${tile.color}20`,
                            borderRadius: '10px',
                          }}
                        >
                          <DynamicIcon name={tile.icon} size={20} color={tile.color} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              fontSize: '0.9rem',
                              fontWeight: 500,
                              color: 'var(--text-primary)',
                            }}
                          >
                            {tile.name}
                          </div>
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: '#f59e0b',
                            }}
                          >
                            Not in dashboard
                          </div>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            gap: '8px',
                          }}
                        >
                          <button
                            onClick={() => onRestoreTile(activityName)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              padding: '8px 12px',
                              background: `${tile.color}15`,
                              border: `1px solid ${tile.color}30`,
                              borderRadius: '8px',
                              color: tile.color,
                              fontSize: '0.8rem',
                              fontWeight: 500,
                              cursor: 'pointer',
                            }}
                          >
                            <Plus size={14} />
                            Add
                          </button>
                          {onEditCustomTile && (
                            <button
                              onClick={() => onEditCustomTile(tile)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '36px',
                                height: '36px',
                                background: 'rgba(0, 149, 246, 0.1)',
                                border: '1px solid rgba(0, 149, 246, 0.3)',
                                borderRadius: '8px',
                                color: '#0095f6',
                                cursor: 'pointer',
                              }}
                              title="Edit tile"
                            >
                              <Pencil size={16} />
                            </button>
                          )}
                          {onDeleteCustomTile && (
                            <button
                              onClick={() => handleDeleteClick(tile.id, tile.name)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '36px',
                                height: '36px',
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                borderRadius: '8px',
                                color: '#ef4444',
                                cursor: 'pointer',
                              }}
                              title="Delete permanently"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
            borderRadius: '24px',
          }}
          onClick={handleCancelDelete}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-primary)',
              borderRadius: '16px',
              padding: '24px',
              width: '280px',
              border: '1px solid var(--border)',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3)',
              animation: 'scaleIn 0.2s ease-out',
            }}
          >
            <style>{`
                            @keyframes scaleIn {
                                from {
                                    opacity: 0;
                                    transform: scale(0.9);
                                }
                                to {
                                    opacity: 1;
                                    transform: scale(1);
                                }
                            }
                        `}</style>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  background: 'rgba(239, 68, 68, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '16px',
                }}
              >
                <AlertTriangle size={24} color="#ef4444" />
              </div>
              <h3
                style={{
                  margin: '0 0 8px',
                  fontSize: '1rem',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                Delete Tile?
              </h3>
              <p
                style={{
                  margin: '0 0 20px',
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                  lineHeight: 1.4,
                }}
              >
                Are you sure you want to permanently delete{' '}
                <strong style={{ color: 'var(--text-primary)' }}>"{deleteConfirm.tileName}"</strong>
                ? This will also delete all activity data for this tile.
              </p>
              <div
                style={{
                  display: 'flex',
                  gap: '12px',
                  width: '100%',
                }}
              >
                <button
                  onClick={handleCancelDelete}
                  style={{
                    flex: 1,
                    padding: '10px 16px',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border)',
                    borderRadius: '10px',
                    color: 'var(--text-primary)',
                    fontSize: '0.85rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmDelete}
                  style={{
                    flex: 1,
                    padding: '10px 16px',
                    background: '#ef4444',
                    border: 'none',
                    borderRadius: '10px',
                    color: 'white',
                    fontSize: '0.85rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HiddenTilesPanel;
