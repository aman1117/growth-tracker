/**
 * Bio Dialog
 *
 * Dialog for editing user bio.
 */

import { X } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { api } from '../../../services/api';
import type { BioDialogProps } from '../SettingsPage.types';
import { DialogWrapper } from './DialogWrapper';

export const BioDialog: React.FC<BioDialogProps> = ({
  isOpen,
  onClose,
  currentBio,
  onSuccess,
}) => {
  const [bio, setBio] = useState(currentBio);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setBio(currentBio);
      setError('');
    }
  }, [isOpen, currentBio]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedBio = bio.trim();

    if (trimmedBio.length > 150) {
      setError('Bio must be 150 characters or less');
      return;
    }

    if (trimmedBio === currentBio) {
      onClose();
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/update-bio', { bio: trimmedBio });
      if (res.success) {
        onSuccess(res.bio || '');
        onClose();
      } else {
        setError(res.error || 'Failed to update bio');
      }
    } catch {
      setError('Failed to update bio');
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
            Edit bio
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
          <textarea
            value={bio}
            onChange={(e) => {
              setBio(e.target.value);
              setError('');
            }}
            placeholder="Write a short bio..."
            maxLength={150}
            autoFocus
            rows={4}
            style={{
              width: '100%',
              padding: '0.75rem',
              borderRadius: '8px',
              border: `1px solid ${error ? '#ef4444' : 'var(--border)'}`,
              backgroundColor: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              fontSize: '16px',
              outline: 'none',
              resize: 'none',
              fontFamily: 'inherit',
            }}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: '0.5rem',
            }}
          >
            <span
              style={{
                fontSize: '0.75rem',
                color: bio.length > 150 ? '#ef4444' : 'var(--text-secondary)',
              }}
            >
              {bio.length}/150
            </span>
            {error && (
              <span
                style={{
                  color: '#ef4444',
                  fontSize: '0.75rem',
                }}
              >
                {error}
              </span>
            )}
          </div>
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
