/**
 * Username Dialog
 *
 * Dialog for changing username with validation.
 */

import { X } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { api } from '../../../services/api';
import type { UsernameDialogProps } from '../SettingsPage.types';
import { DialogWrapper } from './DialogWrapper';

export const UsernameDialog: React.FC<UsernameDialogProps> = ({
  isOpen,
  onClose,
  currentUsername,
  onSuccess,
}) => {
  const [username, setUsername] = useState(currentUsername);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setUsername(currentUsername);
      setError('');
    }
  }, [isOpen, currentUsername]);

  if (!isOpen) return null;

  const validateUsername = (value: string): string | null => {
    if (value.length < 3 || value.length > 20) {
      return 'Username must be 3-20 characters';
    }
    if (!/^[a-z0-9_.]+$/.test(value)) {
      return 'Only lowercase letters, numbers, _ and . allowed';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const validationError = validateUsername(username);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (username === currentUsername) {
      onClose();
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/update-username', { new_username: username });
      if (res.success) {
        onSuccess(res.new_username);
        onClose();
      } else {
        setError(res.error || 'Failed to update username');
      }
    } catch {
      setError('Failed to update username');
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
            Change username
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

        <div style={{ marginBottom: '1rem' }}>
          <label
            style={{
              fontSize: '0.875rem',
              color: 'var(--text-secondary)',
              display: 'block',
              marginBottom: '0.5rem',
            }}
          >
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value.toLowerCase());
              setError('');
            }}
            placeholder="Enter new username"
            autoFocus
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
            {isLoading ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </DialogWrapper>
  );
};
