/**
 * HiddenTilesPanel Component
 *
 * Lists hidden tiles with restore actions. Supports both predefined and custom
 * tiles, and also surfaces custom tiles that exist in the database but are
 * missing from the dashboard order ("not on dashboard").
 * Bottom sheet on phones, dialog on larger screens.
 */

import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, EyeOff, LayoutGrid, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import React, { useCallback, useState } from 'react';

import { createCustomActivityName, getActivityConfig } from '../constants/activities';
import type { ActivityName, CustomTile, PredefinedActivityName } from '../types';
import { isCustomTile } from '../types';
import { DynamicIcon } from './DynamicIcon';
import styles from './HiddenTilesPanel.module.css';
import { ConfirmDialog, EmptyState, Modal } from './ui';

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

interface TileRowProps {
  label: string;
  color: string;
  icon: React.ReactNode;
  meta?: string;
  warning?: boolean;
  restoreLabel: string;
  onRestore: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

/** One tile entry: tinted icon chip, name and its actions */
const TileRow: React.FC<TileRowProps> = ({
  label,
  color,
  icon,
  meta,
  warning = false,
  restoreLabel,
  onRestore,
  onEdit,
  onDelete,
}) => (
  <li
    className={`${styles.row} ${warning ? styles.rowWarning : ''}`}
    style={{ '--tile-color': color } as React.CSSProperties}
  >
    <span className={styles.rowIcon} aria-hidden="true">
      {icon}
    </span>
    <div className={styles.rowText}>
      <span className={styles.rowName}>{label}</span>
      {meta && <span className={styles.rowMeta}>{meta}</span>}
    </div>
    <div className={styles.rowActions}>
      <button
        type="button"
        className={styles.restoreButton}
        onClick={onRestore}
        aria-label={`${restoreLabel} ${label}`}
      >
        {restoreLabel === 'Add' ? (
          <Plus size={15} strokeWidth={2.5} aria-hidden="true" />
        ) : (
          <Undo2 size={15} strokeWidth={2.5} aria-hidden="true" />
        )}
        <span>{restoreLabel}</span>
      </button>
      {onEdit && (
        <button
          type="button"
          className={styles.iconAction}
          onClick={onEdit}
          aria-label={`Edit ${label}`}
          title="Edit tile"
        >
          <Pencil size={16} strokeWidth={2.25} aria-hidden="true" />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          className={`${styles.iconAction} ${styles.dangerAction}`}
          onClick={onDelete}
          aria-label={`Delete ${label} permanently`}
          title="Delete permanently"
        >
          <Trash2 size={16} strokeWidth={2.25} aria-hidden="true" />
        </button>
      )}
    </div>
  </li>
);

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
  // State for delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<{ tileId: string; tileName: string } | null>(
    null
  );

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
  const hiddenCount = hiddenTiles.length;

  const subtitle = !hasContent
    ? 'Everything is on your dashboard'
    : [
        hiddenCount > 0 ? `${hiddenCount} hidden` : null,
        orphanedCustomTiles.length > 0 ? `${orphanedCustomTiles.length} not on dashboard` : null,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <>
      <Modal
        isOpen
        onClose={onClose}
        title="Manage tiles"
        subtitle={subtitle}
        icon={<LayoutGrid size={19} strokeWidth={2.25} />}
        maxWidth="480px"
      >
        <div className={styles.body}>
          {!hasContent ? (
            <EmptyState
              icon={<EyeOff size={26} strokeWidth={2} />}
              title="No hidden tiles"
              description="In edit mode, tap the ✕ on any tile to hide it. It will wait for you here."
              size="sm"
            />
          ) : (
            <>
              {/* Predefined Tiles Section */}
              {hiddenPredefined.length > 0 && (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Default tiles</h3>
                  <ul className={styles.list}>
                    {hiddenPredefined.map((tileName) => {
                      const config = getActivityConfig(tileName, customTiles, colorOverrides);
                      const IconComponent = config.icon as LucideIcon;
                      return (
                        <TileRow
                          key={tileName}
                          label={config.label}
                          color={config.color}
                          icon={<IconComponent size={20} strokeWidth={2.1} />}
                          restoreLabel="Restore"
                          onRestore={() => onRestoreTile(tileName)}
                        />
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* Custom Tiles Section */}
              {hiddenCustom.length > 0 && (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Custom tiles</h3>
                  <ul className={styles.list}>
                    {hiddenCustom.map((tileName) => {
                      const config = getActivityConfig(tileName, customTiles, colorOverrides);
                      const tileId = tileName.replace('custom:', '');
                      // Find the custom tile object for editing
                      const customTileObj = customTiles.find((t) => t.id === tileId);
                      return (
                        <TileRow
                          key={tileName}
                          label={config.label}
                          color={config.color}
                          icon={
                            <DynamicIcon name={config.icon as string} size={20} strokeWidth={2.1} />
                          }
                          meta="Custom tile"
                          restoreLabel="Restore"
                          onRestore={() => onRestoreTile(tileName)}
                          onEdit={
                            onEditCustomTile && customTileObj
                              ? () => onEditCustomTile(customTileObj)
                              : undefined
                          }
                          onDelete={
                            onDeleteCustomTile
                              ? () => setDeleteConfirm({ tileId, tileName: config.label })
                              : undefined
                          }
                        />
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* Orphaned Custom Tiles Section */}
              {orphanedCustomTiles.length > 0 && (
                <section className={styles.section}>
                  <h3 className={`${styles.sectionTitle} ${styles.sectionTitleWarning}`}>
                    <AlertTriangle size={14} strokeWidth={2.5} aria-hidden="true" />
                    Not on your dashboard
                  </h3>
                  <p className={styles.sectionHint}>
                    These custom tiles are saved to your account but aren&apos;t on your dashboard.
                    Add them back or delete them.
                  </p>
                  <ul className={styles.list}>
                    {orphanedCustomTiles.map((tile) => (
                      <TileRow
                        key={tile.id}
                        label={tile.name}
                        color={tile.color}
                        icon={<DynamicIcon name={tile.icon} size={20} strokeWidth={2.1} />}
                        meta="Not on dashboard"
                        warning
                        restoreLabel="Add"
                        onRestore={() => onRestoreTile(createCustomActivityName(tile.id))}
                        onEdit={onEditCustomTile ? () => onEditCustomTile(tile) : undefined}
                        onDelete={
                          onDeleteCustomTile
                            ? () => setDeleteConfirm({ tileId: tile.id, tileName: tile.name })
                            : undefined
                        }
                      />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </Modal>

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <ConfirmDialog
          title={`Delete "${deleteConfirm.tileName}"?`}
          description="This permanently deletes the tile and all the activity logged with it."
          icon={<Trash2 size={22} strokeWidth={2.25} />}
          tone="danger"
          confirmLabel="Delete"
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}
    </>
  );
};

export default HiddenTilesPanel;
