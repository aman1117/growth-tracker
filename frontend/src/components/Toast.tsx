import React, { useEffect, useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

interface ToastProps {
    message: string;
    type: 'success' | 'error' | 'info';
    onClose: () => void;
}

export const Toast: React.FC<ToastProps> = ({ message, type, onClose }) => {
    const [isExiting, setIsExiting] = useState(false);

    const handleClose = useCallback(() => {
        setIsExiting(true);
        setTimeout(onClose, 300); // Wait for animation
    }, [onClose]);

    useEffect(() => {
        const timer = setTimeout(() => {
            handleClose();
        }, 3000);
        return () => clearTimeout(timer);
    }, [handleClose]);

    const getBackgroundColor = () => {
        switch (type) {
            case 'success': return '#166534';
            case 'error': return '#991b1b';
            case 'info': return '#1e40af';
        }
    };

    const getBorderColor = () => {
        switch (type) {
            case 'success': return '#22c55e';
            case 'error': return '#ef4444';
            case 'info': return '#3b82f6';
        }
    };

    const getIcon = () => {
        switch (type) {
            case 'success': return <CheckCircle size={20} color="#22c55e" />;
            case 'error': return <AlertCircle size={20} color="#fca5a5" />;
            case 'info': return <Info size={20} color="#93c5fd" />;
        }
    };

    return ReactDOM.createPortal(
        <div
            className={isExiting ? 'toast-exit' : 'toast-enter'}
            style={{
                position: 'fixed',
                top: '1rem',
                left: '50%',
                transform: 'translateX(-50%)',
                backgroundColor: getBackgroundColor(),
                color: '#ffffff',
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                boxShadow: '0 10px 25px -3px rgba(0, 0, 0, 0.3), 0 4px 10px -2px rgba(0, 0, 0, 0.2)',
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                minWidth: '300px',
                border: `1px solid ${getBorderColor()}`,
            }}
        >
            {getIcon()}

            <span style={{ flex: 1, fontSize: '0.9rem', fontWeight: 500 }}>{message}</span>

            <button
                onClick={handleClose}
                style={{
                    background: 'transparent',
                    color: 'rgba(255, 255, 255, 0.7)',
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
