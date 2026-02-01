/**
 * UsernameEditor Component
 *
 * Inline editor for changing username.
 */

import { Check, User, X } from 'lucide-react';
import React from 'react';

interface UsernameEditorProps {
  isEditing: boolean;
  newUsername: string;
  error: string;
  isLoading: boolean;
  onStartEdit: () => void;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSave: () => void;
  onCancel: () => void;
}

export const UsernameEditor: React.FC<UsernameEditorProps> = ({
  isEditing,
  newUsername,
  error,
  isLoading,
  onStartEdit,
  onChange,
  onSave,
  onCancel,
}) => {
  return (
    <div
      style={{
        padding: '0.5rem',
        borderRadius: '8px',
        marginBottom: '0.125rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          cursor: isEditing ? 'default' : 'pointer',
        }}
        onClick={() => !isEditing && onStartEdit()}
      >
        <div
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            backgroundColor: 'var(--bg-secondary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <User size={14} color="var(--text-secondary)" />
        </div>
        {!isEditing ? (
          <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>Change username</span>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <input
                type="text"
                value={newUsername}
                onChange={onChange}
                placeholder="New username"
                autoFocus
                style={{
                  flex: 1,
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  border: `1px solid ${error ? '#ef4444' : 'var(--border)'}`,
                  backgroundColor: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontSize: '16px',
                  outline: 'none',
                }}
              />
              <button
                onClick={onSave}
                disabled={isLoading}
                style={{
                  padding: '0.4rem',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: 'var(--accent)',
                  color: 'white',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: isLoading ? 0.7 : 1,
                }}
              >
                <Check size={14} />
              </button>
              <button
                onClick={onCancel}
                style={{
                  padding: '0.4rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  backgroundColor: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <X size={14} />
              </button>
            </div>
            {error && <div style={{ color: '#ef4444', fontSize: '0.7rem' }}>{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
};
