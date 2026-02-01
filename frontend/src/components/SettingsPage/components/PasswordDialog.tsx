/**
 * Password Dialog
 *
 * Dialog for changing password.
 */

import { X } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { api } from '../../../services/api';
import type { PasswordDialogProps } from '../SettingsPage.types';
import { DialogWrapper } from './DialogWrapper';

export const PasswordDialog: React.FC<PasswordDialogProps> = ({ isOpen, onClose, onSuccess }) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCurrentPassword('');
      setNewPassword('');
      setError('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentPassword || !newPassword) {
      setError('All fields are required');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      if (res.success) {
        onSuccess();
        onClose();
      } else {
        setError(res.error || 'Failed to change password');
      }
    } catch {
      setError('Failed to change password');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DialogWrapper onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1rem',
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: '1.125rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            Change password
          </h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: '0.25rem',
            }}
          >
            <X size={20} />
          </button>
        </div>

        <div style={{ marginBottom: '0.75rem' }}>
          <label
            style={{
              fontSize: '0.875rem',
              color: 'var(--text-secondary)',
              display: 'block',
              marginBottom: '0.5rem',
            }}
          >
            Current password
          </label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              setError('');
            }}
            placeholder="Enter current password"
            autoFocus
            style={{
              width: '100%',
              padding: '0.75rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              fontSize: '16px', // Prevents iOS auto-zoom
              outline: 'none',
            }}
          />
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label
            style={{
              fontSize: '0.875rem',
              color: 'var(--text-secondary)',
              display: 'block',
              marginBottom: '0.5rem',
            }}
          >
            New password
          </label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setError('');
            }}
            placeholder="Enter new password"
            style={{
              width: '100%',
              padding: '0.75rem',
              borderRadius: '8px',
              border: `1px solid ${error ? '#ef4444' : 'var(--border)'}`,
              backgroundColor: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              fontSize: '16px', // Prevents iOS auto-zoom
              outline: 'none',
            }}
          />
          {error && (
            <p
              style={{
                color: '#ef4444',
                fontSize: '0.75rem',
                marginTop: '0.5rem',
                margin: '0.5rem 0 0 0',
              }}
            >
              {error}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-outline"
            style={{ flex: 1, padding: '0.6rem', fontSize: '0.85rem' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary"
            style={{
              flex: 1,
              padding: '0.6rem',
              fontSize: '0.85rem',
              opacity: isLoading ? 0.7 : 1,
            }}
          >
            {isLoading ? 'Saving...' : 'Update'}
          </button>
        </div>
      </form>
    </DialogWrapper>
  );
};
