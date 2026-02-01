/**
 * PasswordEditor Component
 *
 * Inline editor for changing password.
 */

import { Check, Key } from 'lucide-react';
import React from 'react';

interface PasswordEditorProps {
  isEditing: boolean;
  currentPassword: string;
  newPassword: string;
  error: string;
  isLoading: boolean;
  success: boolean;
  onStartEdit: () => void;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export const PasswordEditor: React.FC<PasswordEditorProps> = ({
  isEditing,
  currentPassword,
  newPassword,
  error,
  isLoading,
  success,
  onStartEdit,
  onCurrentPasswordChange,
  onNewPasswordChange,
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
          <Key size={14} color="var(--text-secondary)" />
        </div>
        {!isEditing ? (
          <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>Change password</span>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {success ? (
              <div
                style={{
                  color: '#22c55e',
                  fontSize: '0.8rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                }}
              >
                <Check size={14} /> Password changed!
              </div>
            ) : (
              <>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => onCurrentPasswordChange(e.target.value)}
                  placeholder="Current password"
                  autoFocus
                  style={{
                    padding: '0.4rem 0.6rem',
                    borderRadius: '6px',
                    border: `1px solid ${error ? '#ef4444' : 'var(--border)'}`,
                    backgroundColor: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    fontSize: '16px',
                    outline: 'none',
                  }}
                />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => onNewPasswordChange(e.target.value)}
                  placeholder="New password (min 8 chars)"
                  style={{
                    padding: '0.4rem 0.6rem',
                    borderRadius: '6px',
                    border: `1px solid ${error ? '#ef4444' : 'var(--border)'}`,
                    backgroundColor: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    fontSize: '16px',
                    outline: 'none',
                  }}
                />
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    onClick={onSave}
                    disabled={isLoading}
                    style={{
                      flex: 1,
                      padding: '0.4rem',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: 'var(--accent)',
                      color: 'white',
                      cursor: isLoading ? 'not-allowed' : 'pointer',
                      fontSize: '0.75rem',
                      opacity: isLoading ? 0.7 : 1,
                    }}
                  >
                    {isLoading ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={onCancel}
                    style={{
                      padding: '0.4rem 0.6rem',
                      borderRadius: '6px',
                      border: '1px solid var(--border)',
                      backgroundColor: 'transparent',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                    }}
                  >
                    Cancel
                  </button>
                </div>
                {error && <div style={{ color: '#ef4444', fontSize: '0.7rem' }}>{error}</div>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
