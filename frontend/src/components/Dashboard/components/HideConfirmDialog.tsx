/**
 * HideConfirmDialog Component
 *
 * Confirmation dialog for hiding a tile from the dashboard.
 */

import { EyeOff } from 'lucide-react';
import React from 'react';

import { ConfirmDialog } from '../../ui';

interface HideConfirmDialogProps {
  displayName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const HideConfirmDialog: React.FC<HideConfirmDialogProps> = ({
  displayName,
  onConfirm,
  onCancel,
}) => {
  return (
    <ConfirmDialog
      title="Hide this tile?"
      description={
        <>
          <strong>{displayName}</strong> will disappear from your grid. You can bring it back
          anytime from Manage tiles.
        </>
      }
      icon={<EyeOff />}
      tone="warning"
      confirmLabel="Hide"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
};
