import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { CheckCircle, AlertCircle, X } from 'lucide-react';

interface ToastProps {
    message: string;
    type: 'success' | 'error';
    onClose: () => void;
}

export const Toast: React.FC<ToastProps> = ({ message, type, onClose }) => {
    const [isExiting, setIsExiting] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            handleClose();
        }, 3000);
        return () => clearTimeout(timer);
    }, []);

    const handleClose = () => {
        setIsExiting(true);
        setTimeout(onClose, 300); // Wait for animation
    };

    return ReactDOM.createPortal(
        <div
            className={isExiting ? 'toast-exit' : 'toast-enter'}
            style={{
                position: 'fixed',
                top: '1rem',
                left: '50%',
                transform: 'translateX(-50%)',
                backgroundColor: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
                zIndex: 9999, // High z-index
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                minWidth: '300px',
                border: '1px solid var(--border)',
            }}
        >
            {type === 'success' ? (
                <CheckCircle size={20} color="var(--success)" fill="var(--success)" stroke="white" />
            ) : (
                <AlertCircle size={20} color="var(--error)" fill="var(--error)" stroke="white" />
            )}

            <span style={{ flex: 1, fontSize: '0.9rem', fontWeight: 500 }}>{message}</span>

            <button
                onClick={handleClose}
                style={{
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    padding: '0.25rem',
                    display: 'flex'
                }}
            >
                <X size={16} />
            </button>
        </div>,
        document.body
    );
};
