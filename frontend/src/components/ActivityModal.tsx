import React, { useState, useEffect } from 'react';
import type { ActivityName } from '../types';
import { X } from 'lucide-react';

interface ActivityModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (hours: number) => Promise<void>;
    activityName: ActivityName | null;
    currentHours: number;
}

export const ActivityModal: React.FC<ActivityModalProps> = ({
    isOpen,
    onClose,
    onSave,
    activityName,
    currentHours
}) => {
    const [hours, setHours] = useState<string>('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (isOpen) {
            setHours(currentHours > 0 ? currentHours.toString() : '');
            setError('');
        }
    }, [isOpen, currentHours]);

    if (!isOpen || !activityName) return null;

    const displayName = activityName.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const numHours = parseFloat(hours);

        if (isNaN(numHours) || numHours < 0 || numHours > 24) {
            setError('Please enter a valid number between 0 and 24');
            return;
        }

        setLoading(true);
        try {
            await onSave(numHours);
            onClose();
        } catch (err) {
            setError('Failed to save activity');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '1rem'
        }}>
            <div className="card" style={{ width: '100%', maxWidth: '400px', position: 'relative' }}>
                <button
                    onClick={onClose}
                    style={{
                        position: 'absolute',
                        top: '1rem',
                        right: '1rem',
                        background: 'none',
                        color: 'var(--text-secondary)',
                        border: 'none'
                    }}
                >
                    <X size={24} />
                </button>

                <h2 className="mb-4">Log {displayName}</h2>

                {error && (
                    <div style={{ color: 'var(--error)', marginBottom: '1rem', fontSize: '0.875rem' }}>
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    <div className="input-group">
                        <label className="input-label">Duration (Hours)</label>
                        <input
                            type="number"
                            step="0.1"
                            min="0"
                            max="24"
                            className="input-field"
                            value={hours}
                            onChange={(e) => setHours(e.target.value)}
                            placeholder="e.g. 1.5"
                            autoFocus
                        />
                    </div>

                    <div className="flex gap-4 mt-4">
                        <button type="button" onClick={onClose} className="btn btn-outline" style={{ flex: 1 }}>
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={loading}>
                            {loading ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
