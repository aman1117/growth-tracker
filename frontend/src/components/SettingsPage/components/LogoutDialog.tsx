/**
 * Logout Dialog
 *
 * Confirmation dialog for logging out.
 */

import { AlertTriangle } from 'lucide-react';
import React from 'react';

import type { LogoutDialogProps } from '../SettingsPage.types';
import { DialogWrapper } from './DialogWrapper';

export const LogoutDialog: React.FC<LogoutDialogProps> = ({ isOpen, onClose, onConfirm }) => {
  if (!isOpen) return null;

  return (
    <DialogWrapper onClose={onClose}>
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1rem',
          }}
        >
          <AlertTriangle size={28} color="#ef4444" />
        </div>

        <h3
          style={{
            margin: '0 0 0.5rem',
            fontSize: '1.125rem',
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          Log out?
        </h3>

        <p
          style={{
            margin: '0 0 1.5rem',
            fontSize: '0.875rem',
            color: 'var(--text-secondary)',
          }}
        >
          Are you sure you want to log out of your account?
        </p>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: '0.75rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              backgroundColor: 'transparent',
              color: 'var(--text-primary)',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1,
              padding: '0.75rem',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: '#ef4444',
              color: 'white',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Log out
          </button>
        </div>
      </div>
    </DialogWrapper>
  );
};
