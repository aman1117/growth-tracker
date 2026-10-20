/**
 * Logout Dialog
 *
 * Confirmation dialog for logging out (shared ConfirmDialog, danger tone).
 */

import { LogOut } from 'lucide-react';
import React from 'react';

import { ConfirmDialog } from '../../ui';
import type { LogoutDialogProps } from '../SettingsPage.types';

export const LogoutDialog: React.FC<LogoutDialogProps> = ({ isOpen, onClose, onConfirm }) => (
  <ConfirmDialog
    isOpen={isOpen}
    title="Log out?"
    description="You'll need to sign in again to keep tracking on this device."
    icon={<LogOut size={24} strokeWidth={2.25} />}
    tone="danger"
    confirmLabel="Log out"
    cancelLabel="Cancel"
    onConfirm={onConfirm}
    onCancel={onClose}
  />
);
