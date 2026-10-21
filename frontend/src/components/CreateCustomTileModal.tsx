/**
 * CreateCustomTileModal Component
 *
 * A modal for creating and editing custom tiles.
 * Live tile preview, name input, icon picker and color picker.
 */

import { AlertCircle, Pencil, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useId, useState } from 'react';

import { ACTIVITY_CONFIG, DEFAULT_TILE_COLOR } from '../constants';
import type { CustomTile, PredefinedActivityName } from '../types';
import { ACTIVITY_NAMES, MAX_CUSTOM_TILES } from '../types';
import { getOnColorTone } from '../utils/color';
import { applyCharacterLimit, characterCount } from '../utils/text';
import { ColorPicker } from './ColorPicker';
import styles from './CreateCustomTileModal.module.css';
import { DynamicIcon } from './DynamicIcon';
import { IconPicker } from './IconPicker';
import { Button, Modal } from './ui';

interface CreateCustomTileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (tile: CustomTile) => void;
  existingTile?: CustomTile; // For editing mode
  currentTileCount: number;
  existingTiles: CustomTile[]; // All current custom tiles for validation
}

const NAME_LIMIT = 20;
const DEFAULT_ICON = 'Sparkles';

// Generate UUID v4
const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export const CreateCustomTileModal: React.FC<CreateCustomTileModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingTile,
  currentTileCount,
  existingTiles,
}) => {
  const isEditing = !!existingTile;

  const [name, setName] = useState(existingTile?.name || '');
  const [icon, setIcon] = useState(existingTile?.icon || DEFAULT_ICON);
  const [color, setColor] = useState(existingTile?.color || DEFAULT_TILE_COLOR);
  const [error, setError] = useState<string | null>(null);

  const formId = useId();
  const nameId = useId();
  const nameCountId = useId();
  const iconLabelId = useId();
  const colorLabelId = useId();

  // Reset form when modal opens/closes or existingTile changes
  useEffect(() => {
    if (isOpen) {
      setName(existingTile?.name || '');
      setIcon(existingTile?.icon || DEFAULT_ICON);
      setColor(existingTile?.color || DEFAULT_TILE_COLOR);
      setError(null);
    }
  }, [isOpen, existingTile]);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();

      // Validate name
      const trimmedName = name.trim();
      if (!trimmedName) {
        setError('Please enter a name for your tile');
        return;
      }
      if (characterCount(trimmedName) > NAME_LIMIT) {
        setError('Name cannot exceed 20 characters');
        return;
      }

      // Check for name collision with predefined tiles
      const predefinedMatch = ACTIVITY_NAMES.find((actName) => {
        const config = ACTIVITY_CONFIG[actName as PredefinedActivityName];
        return config && config.label.toLowerCase() === trimmedName.toLowerCase();
      });
      if (predefinedMatch) {
        const config = ACTIVITY_CONFIG[predefinedMatch as PredefinedActivityName];
        setError(`"${config.label}" is a built-in tile name`);
        return;
      }

      // Check for duplicate names (case insensitive)
      const duplicateTile = existingTiles.find(
        (t) => t.name.toLowerCase() === trimmedName.toLowerCase() && t.id !== existingTile?.id
      );
      if (duplicateTile) {
        setError(`A tile named "${duplicateTile.name}" already exists`);
        return;
      }

      // Validate icon
      if (!icon) {
        setError('Please select an icon');
        return;
      }

      // Check limit (only for new tiles)
      if (!isEditing && currentTileCount >= MAX_CUSTOM_TILES) {
        setError(`Maximum of ${MAX_CUSTOM_TILES} custom tiles allowed`);
        return;
      }

      const tile: CustomTile = {
        id: existingTile?.id || generateUUID(),
        name: trimmedName,
        icon,
        color,
      };

      onSave(tile);
      onClose();
    },
    [name, icon, color, existingTile, isEditing, currentTileCount, existingTiles, onSave, onClose]
  );

  // Limits by characters (as the server counts them), so each emoji counts once
  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = applyCharacterLimit(e.target.value, name, NAME_LIMIT);
      // Typing into a full field changes nothing, so any error message stays
      if (value === name) return;
      setName(value);
      setError(null);
    },
    [name]
  );

  if (!isOpen) return null;

  const canSubmit = !!name.trim() && !!icon;
  const previewTone = getOnColorTone(color);
  const atLimit = !isEditing && currentTileCount >= MAX_CUSTOM_TILES;
  const remainingSlots = Math.max(0, MAX_CUSTOM_TILES - currentTileCount);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isEditing ? 'Edit tile' : 'New custom tile'}
      subtitle={
        isEditing
          ? 'Updates everywhere this tile appears'
          : atLimit
            ? `You've reached the ${MAX_CUSTOM_TILES}-tile limit`
            : `Room for ${remainingSlots} more custom tile${remainingSlots === 1 ? '' : 's'}`
      }
      icon={
        isEditing ? <Pencil size={18} strokeWidth={2.25} /> : <Plus size={20} strokeWidth={2.5} />
      }
      maxWidth="420px"
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            className={styles.footerButton}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!canSubmit} className={styles.footerButton}>
            {isEditing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={handleSubmit} noValidate>
        {/* Error Message */}
        {error && (
          <div className={styles.error} role="alert">
            <AlertCircle size={16} strokeWidth={2.25} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {/* Preview + Name Row */}
        <div className={styles.identityRow}>
          <div
            className={`${styles.preview} ${previewTone === 'light' ? styles.onLight : styles.onDark}`}
            style={{ '--tile-color': color } as React.CSSProperties}
            aria-hidden="true"
          >
            <span className={styles.previewIcon}>
              <DynamicIcon name={icon} size={20} strokeWidth={2.1} />
            </span>
            <span className={styles.previewName}>{name.trim() || 'Your tile'}</span>
            <span className={styles.previewHours}>
              1.5<span className={styles.previewUnit}>h</span>
            </span>
          </div>

          <div className={styles.nameField}>
            <label htmlFor={nameId} className={styles.label}>
              Name
            </label>
            <input
              id={nameId}
              type="text"
              value={name}
              onChange={handleNameChange}
              placeholder="e.g. Guitar practice"
              autoComplete="off"
              enterKeyHint="done"
              className={styles.nameInput}
              aria-describedby={nameCountId}
              aria-invalid={!!error || undefined}
            />
            <span id={nameCountId} className={styles.counter}>
              {characterCount(name)}/{NAME_LIMIT}
            </span>
          </div>
        </div>

        {/* Icon Picker */}
        <section className={styles.section} aria-labelledby={iconLabelId}>
          <h3 id={iconLabelId} className={styles.sectionLabel}>
            Icon
          </h3>
          <IconPicker value={icon} onChange={setIcon} color={color} />
        </section>

        {/* Color Picker */}
        <section className={styles.section} aria-labelledby={colorLabelId}>
          <h3 id={colorLabelId} className={styles.sectionLabel}>
            Color
          </h3>
          <ColorPicker value={color} onChange={setColor} />
        </section>
      </form>
    </Modal>
  );
};

export default CreateCustomTileModal;
