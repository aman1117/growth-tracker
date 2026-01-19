import React, { useState, useEffect, useRef } from 'react';
import type { ActivityName } from '../types';
import { getActivityConfig } from '../constants/activities';
import { X, ChevronDown, Plus, Minus } from 'lucide-react';
import type { CustomTile } from '../types';

interface ActivityModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (hours: number, note?: string) => Promise<void>;
    activityName: ActivityName | null;
    currentHours: number;
    currentNote?: string;
    customTiles?: CustomTile[];  // Pass custom tiles for name lookup
}

export const ActivityModal: React.FC<ActivityModalProps> = ({
    isOpen,
    onClose,
    onSave,
    activityName,
    currentHours,
    currentNote,
    customTiles = [],
}) => {
    const [hours, setHours] = useState<string>('');
    const [note, setNote] = useState<string>('');
    const [isNoteExpanded, setIsNoteExpanded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const noteInputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (isOpen) {
            setHours(currentHours > 0 ? currentHours.toString() : '');
            setNote(currentNote || '');
            setIsNoteExpanded(false);
            setError('');
        }
    }, [isOpen, currentHours, currentNote]);

    // Focus note field when expanded
    useEffect(() => {
        if (isNoteExpanded && noteInputRef.current) {
            noteInputRef.current.focus();
        }
    }, [isNoteExpanded]);

    if (!isOpen || !activityName) return null;

    // Get display name - use getActivityConfig for custom tiles
    const config = getActivityConfig(activityName, customTiles);
    const displayName = config.label;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const numHours = parseFloat(hours);

        if (isNaN(numHours) || numHours < 0 || numHours > 24) {
            setError('Please enter a valid number between 0 and 24');
            return;
        }

        // Check if it's a multiple of 0.25
        // Multiply by 4 and check if it's an integer (roughly) to avoid float precision issues
        // Or string check?
        // Let's use a small epsilon for float comparison or just simple math
        const remainder = (numHours * 100) % 25;
        if (remainder !== 0) {
            setError('Hours must be in increments of 0.25 (e.g., 0.25, 0.5, 0.75)');
            return;
        }

        setLoading(true);
        try {
            // Pass note only if it has content, otherwise pass undefined
            const trimmedNote = note.trim();
            await onSave(numHours, trimmedNote || undefined);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save activity');
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
            backgroundColor: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            zIndex: 100,
            padding: '1rem',
            paddingTop: '15vh',
            overflowY: 'auto',
        }}
        onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
        }}
        >
            <div 
                className="card" 
                style={{ 
                    width: '100%', 
                    maxWidth: '340px', 
                    position: 'relative',
                    animation: 'modalSlideIn 0.2s ease-out',
                    padding: '1rem 1.25rem',
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
                    @keyframes noteExpand {
                        from {
                            opacity: 0;
                            max-height: 0;
                        }
                        to {
                            opacity: 1;
                            max-height: 150px;
                        }
                    }
                    @keyframes noteCollapse {
                        from {
                            opacity: 1;
                            max-height: 150px;
                        }
                        to {
                            opacity: 0;
                            max-height: 0;
                        }
                    }
                `}</style>
                <button
                    onClick={onClose}
                    style={{
                        position: 'absolute',
                        top: '0.75rem',
                        right: '0.75rem',
                        background: 'none',
                        color: 'var(--text-secondary)',
                        border: 'none',
                        padding: '0.25rem',
                        transition: 'transform 0.15s ease, color 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'scale(1.1)';
                        e.currentTarget.style.color = 'var(--text-primary)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'scale(1)';
                        e.currentTarget.style.color = 'var(--text-secondary)';
                    }}
                >
                    <X size={20} />
                </button>

                <h3 style={{ marginBottom: '0.75rem', fontSize: '1.1rem' }}>Log {displayName}</h3>

                {error && (
                    <div style={{ 
                        color: 'var(--error)', 
                        marginBottom: '0.5rem', 
                        fontSize: '0.8rem',
                        animation: 'shake 0.3s ease-in-out',
                    }}>
                        <style>{`
                            @keyframes shake {
                                0%, 100% { transform: translateX(0); }
                                25% { transform: translateX(-5px); }
                                75% { transform: translateX(5px); }
                            }
                        `}</style>
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    <div style={{ marginBottom: '0.75rem' }}>
                        <label 
                            className="input-label" 
                            style={{ 
                                fontSize: '0.8rem', 
                                marginBottom: '0.35rem', 
                                display: 'block' 
                            }}
                        >
                            Hours
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {/* -0.5 button */}
                            <button
                                type="button"
                                onClick={() => {
                                    const current = parseFloat(hours) || 0;
                                    const newVal = Math.max(0, current - 0.5);
                                    setHours(newVal.toString());
                                }}
                                style={{
                                    width: '36px',
                                    height: '36px',
                                    borderRadius: '10px',
                                    border: '1px solid var(--border)',
                                    background: 'var(--bg-secondary)',
                                    color: 'var(--text-primary)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    transition: 'all 0.2s ease',
                                    flexShrink: 0,
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                }}
                                title="-0.5"
                            >
                                -.5
                            </button>
                            {/* -0.25 button */}
                            <button
                                type="button"
                                onClick={() => {
                                    const current = parseFloat(hours) || 0;
                                    const newVal = Math.max(0, current - 0.25);
                                    setHours(newVal.toString());
                                }}
                                style={{
                                    width: '36px',
                                    height: '36px',
                                    borderRadius: '10px',
                                    border: '1px solid var(--border)',
                                    background: 'var(--bg-secondary)',
                                    color: 'var(--text-primary)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    transition: 'all 0.2s ease',
                                    flexShrink: 0,
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                }}
                                title="-0.25"
                            >
                                -.25
                            </button>
                            <input
                                type="number"
                                step="0.25"
                                min="0"
                                max="24"
                                className="input-field"
                                value={hours}
                                onChange={(e) => setHours(e.target.value)}
                                placeholder="e.g. 0.25"
                                autoFocus
                                style={{ 
                                    padding: '0.6rem 0.75rem', 
                                    fontSize: '16px', // Prevents iOS auto-zoom
                                    flex: 1,
                                    textAlign: 'center',
                                }}
                            />
                            {/* +0.25 button */}
                            <button
                                type="button"
                                onClick={() => {
                                    const current = parseFloat(hours) || 0;
                                    const newVal = Math.min(24, current + 0.25);
                                    setHours(newVal.toString());
                                }}
                                style={{
                                    width: '36px',
                                    height: '36px',
                                    borderRadius: '10px',
                                    border: '1px solid var(--border)',
                                    background: 'var(--bg-secondary)',
                                    color: 'var(--text-primary)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    transition: 'all 0.2s ease',
                                    flexShrink: 0,
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                }}
                                title="+0.25"
                            >
                                +.25
                            </button>
                            {/* +0.5 button */}
                            <button
                                type="button"
                                onClick={() => {
                                    const current = parseFloat(hours) || 0;
                                    const newVal = Math.min(24, current + 0.5);
                                    setHours(newVal.toString());
                                }}
                                style={{
                                    width: '36px',
                                    height: '36px',
                                    borderRadius: '10px',
                                    border: '1px solid var(--border)',
                                    background: 'var(--bg-secondary)',
                                    color: 'var(--text-primary)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    transition: 'all 0.2s ease',
                                    flexShrink: 0,
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                }}
                                title="+0.5"
                            >
                                +.5
                            </button>
                        </div>
                    </div>

                    {/* Note Field - Clean expandable design */}
                    <div style={{ marginBottom: '0.75rem' }}>
                        <div 
                            style={{ 
                                display: 'flex', 
                                justifyContent: 'space-between', 
                                alignItems: 'center',
                                marginBottom: '0.25rem',
                            }}
                        >
                            <label 
                                className="input-label" 
                                style={{ margin: 0, fontSize: '0.8rem' }}
                            >
                                Note
                            </label>
                            <span style={{ 
                                fontSize: '0.7rem', 
                                color: note.length >= 500 ? 'var(--error)' : 'var(--text-muted)',
                                opacity: note.length > 0 ? 1 : 0,
                                transition: 'opacity 0.2s ease',
                            }}>
                                {note.length}/500
                            </span>
                        </div>
                        <div 
                            style={{ 
                                position: 'relative',
                                borderRadius: '10px',
                                border: '1px solid var(--border)',
                                backgroundColor: 'var(--bg-secondary)',
                                transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                                overflow: 'hidden',
                            }}
                            onFocus={() => {}}
                        >
                            <textarea
                                ref={noteInputRef}
                                value={note}
                                onChange={(e) => setNote(e.target.value.slice(0, 500))}
                                onFocus={() => setIsNoteExpanded(true)}
                                placeholder="Add a note..."
                                maxLength={500}
                                style={{
                                    width: '100%',
                                    padding: '0.5rem 0.75rem',
                                    border: 'none',
                                    background: 'transparent',
                                    color: 'var(--text-primary)',
                                    fontSize: '16px', // Prevents iOS Safari auto-zoom
                                    fontFamily: 'inherit',
                                    lineHeight: '1.5',
                                    resize: 'none',
                                    outline: 'none',
                                    minHeight: isNoteExpanded ? '80px' : '44px',
                                    maxHeight: isNoteExpanded ? '120px' : '44px',
                                    transition: 'min-height 0.25s ease, max-height 0.25s ease',
                                    overflow: isNoteExpanded ? 'auto' : 'hidden',
                                }}
                            />
                            {/* Expand button - small and subtle */}
                            {!isNoteExpanded && note.length > 50 && (
                                <div
                                    onClick={() => setIsNoteExpanded(true)}
                                    style={{
                                        position: 'absolute',
                                        bottom: '6px',
                                        right: '6px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        width: '18px',
                                        height: '18px',
                                        borderRadius: '50%',
                                        backgroundColor: 'var(--border-strong)',
                                        color: 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        transition: 'all 0.2s ease',
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.backgroundColor = 'var(--text-muted)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.backgroundColor = 'var(--border-strong)';
                                    }}
                                >
                                    <ChevronDown size={10} />
                                </div>
                            )}
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
                        <button type="button" onClick={onClose} className="btn btn-outline" style={{ flex: 1, padding: '0.6rem', fontSize: '0.85rem' }}>
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary" style={{ flex: 1, padding: '0.6rem', fontSize: '0.85rem' }} disabled={loading}>
                            {loading ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
