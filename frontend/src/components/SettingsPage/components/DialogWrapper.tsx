/**
 * Dialog Wrapper Component
 *
 * Shared wrapper for all modal dialogs with backdrop and animation.
 */

import React from 'react';

import { useBackDismiss } from '../../../hooks/useBackDismiss';
import type { DialogWrapperProps } from '../SettingsPage.types';

export const DialogWrapper: React.FC<DialogWrapperProps> = ({ children, onClose }) => {
  // Mounted only while a dialog is open, so it is always "open" from history's view
  useBackDismiss(true, onClose);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
        paddingTop: '15vh',
        overflowY: 'auto',
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: '340px',
          padding: '1.25rem',
          animation: 'modalSlideIn 0.2s ease-out',
        }}
      >
        <style>{`
        @keyframes modalSlideIn {
          from {
            opacity: 0;
            transform: translateY(-10px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
        {children}
      </div>
    </div>
  );
};
