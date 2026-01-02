import React, { useState, useEffect } from 'react';
import { X, User, Palette, LogOut, Check, Lock, Key } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { api } from '../utils/api';

interface ProfileDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onLogout: () => void;
}

export const ProfileDialog: React.FC<ProfileDialogProps> = ({ isOpen, onClose, onLogout }) => {
    const { user, updateUsername } = useAuth();
    const { theme, toggleTheme } = useTheme();
    const [isEditingUsername, setIsEditingUsername] = useState(false);
    const [newUsername, setNewUsername] = useState(user?.username || '');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isPrivate, setIsPrivate] = useState(false);
    const [isPrivacyLoading, setIsPrivacyLoading] = useState(false);

    // Change password state
    const [isChangingPassword, setIsChangingPassword] = useState(false);
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [passwordError, setPasswordError] = useState('');
    const [isPasswordLoading, setIsPasswordLoading] = useState(false);
    const [passwordSuccess, setPasswordSuccess] = useState(false);

    // Fetch privacy setting when dialog opens
    useEffect(() => {
        if (isOpen && user) {
            api.get('/get-privacy').then(res => {
                if (res.success) {
                    setIsPrivate(res.is_private);
                }
            });
        }
    }, [isOpen, user]);

    if (!isOpen || !user) return null;

    const togglePrivacy = async () => {
        setIsPrivacyLoading(true);
        try {
            const res = await api.post('/update-privacy', { is_private: !isPrivate });
            if (res.success) {
                setIsPrivate(res.is_private);
            }
        } catch (err) {
            console.error('Failed to update privacy');
        } finally {
            setIsPrivacyLoading(false);
        }
    };

    const validateUsername = (username: string): string | null => {
        if (username.length < 3 || username.length > 20) {
            return 'Username must be 3-20 characters';
        }
        if (!/^[a-z0-9_.]+$/.test(username)) {
            return 'Only lowercase letters, numbers, _ and . allowed';
        }
        return null;
    };

    const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value.toLowerCase();
        setNewUsername(value);
        setError('');
    };

    const handleSaveUsername = async () => {
        const validationError = validateUsername(newUsername);
        if (validationError) {
            setError(validationError);
            return;
        }

        if (newUsername === user.username) {
            setIsEditingUsername(false);
            return;
        }

        setIsLoading(true);
        try {
            const res = await api.post('/update-username', { new_username: newUsername });
            if (res.success) {
                updateUsername(res.new_username);
                setIsEditingUsername(false);
                setError('');
            } else {
                setError(res.error || 'Failed to update username');
            }
        } catch (err) {
            setError('Failed to update username');
        } finally {
            setIsLoading(false);
        }
    };

    const handleCancelEdit = () => {
        setNewUsername(user.username);
        setIsEditingUsername(false);
        setError('');
    };

    const handleChangePassword = async () => {
        if (currentPassword.length === 0 || newPassword.length === 0) {
            setPasswordError('All fields are required');
            return;
        }
        if (newPassword.length < 8) {
            setPasswordError('Password must be at least 8 characters');
            return;
        }

        setIsPasswordLoading(true);
        setPasswordError('');
        try {
            const res = await api.post('/change-password', {
                current_password: currentPassword,
                new_password: newPassword
            });
            if (res.success) {
                setPasswordSuccess(true);
                setCurrentPassword('');
                setNewPassword('');
                setTimeout(() => {
                    setIsChangingPassword(false);
                    setPasswordSuccess(false);
                }, 1500);
            } else {
                setPasswordError(res.error || 'Failed to change password');
            }
        } catch (err) {
            setPasswordError('Failed to change password');
        } finally {
            setIsPasswordLoading(false);
        }
    };

    const handleCancelPasswordChange = () => {
        setCurrentPassword('');
        setNewPassword('');
        setPasswordError('');
        setIsChangingPassword(false);
        setPasswordSuccess(false);
    };

    return (
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'center',
                zIndex: 100,
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                paddingTop: '15vh'
            }}
            onClick={onClose}
        >
            <div
                style={{
                    width: '100%',
                    maxWidth: '300px',
                    background: 'var(--glass-bg)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    borderRadius: '14px',
                    boxShadow: 'var(--glass-shadow)',
                    border: '1px solid var(--glass-border)',
                    overflow: 'hidden',
                    margin: '0 1rem'
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div
                    style={{
                        padding: '0.75rem 1rem',
                        borderBottom: '1px solid var(--border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                    }}
                >
                    <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Profile
                    </span>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            padding: '0.25rem',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Profile Avatar */}
                <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
                    <div
                        style={{
                            width: '48px',
                            height: '48px',
                            borderRadius: '50%',
                            backgroundColor: 'var(--avatar-bg)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 700,
                            fontSize: '1.25rem',
                            color: 'var(--text-primary)',
                            textTransform: 'uppercase'
                        }}
                    >
                        {user.username.charAt(0)}
                    </div>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        @{user.username}
                    </span>
                </div>

                {/* Options */}
                <div style={{ padding: '0 0.5rem 0.5rem' }}>
                    {/* Change Username */}
                    <div
                        style={{
                            padding: '0.5rem',
                            borderRadius: '8px',
                            marginBottom: '0.125rem'
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.6rem',
                                cursor: isEditingUsername ? 'default' : 'pointer'
                            }}
                            onClick={() => !isEditingUsername && setIsEditingUsername(true)}
                        >
                            <div
                                style={{
                                    width: '28px',
                                    height: '28px',
                                    borderRadius: '6px',
                                    backgroundColor: 'var(--bg-secondary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                            >
                                <User size={14} color="var(--text-secondary)" />
                            </div>
                            {!isEditingUsername ? (
                                <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                                    Change username
                                </span>
                            ) : (
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <input
                                            type="text"
                                            value={newUsername}
                                            onChange={handleUsernameChange}
                                            placeholder="New username"
                                            autoFocus
                                            style={{
                                                flex: 1,
                                                padding: '0.4rem 0.6rem',
                                                borderRadius: '6px',
                                                border: `1px solid ${error ? '#ef4444' : 'var(--border)'}`,
                                                backgroundColor: 'var(--bg-secondary)',
                                                color: 'var(--text-primary)',
                                                fontSize: '0.8rem',
                                                outline: 'none'
                                            }}
                                        />
                                        <button
                                            onClick={handleSaveUsername}
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
                                                opacity: isLoading ? 0.7 : 1
                                            }}
                                        >
                                            <Check size={14} />
                                        </button>
                                        <button
                                            onClick={handleCancelEdit}
                                            style={{
                                                padding: '0.4rem',
                                                borderRadius: '6px',
                                                border: '1px solid var(--border)',
                                                backgroundColor: 'transparent',
                                                color: 'var(--text-secondary)',
                                                cursor: 'pointer',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center'
                                            }}
                                        >
                                            <X size={14} />
                                        </button>
                                    </div>
                                    {error && (
                                        <div style={{ color: '#ef4444', fontSize: '0.7rem' }}>
                                            {error}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Change Password */}
                    <div
                        style={{
                            padding: '0.5rem',
                            borderRadius: '8px',
                            marginBottom: '0.125rem'
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.6rem',
                                cursor: isChangingPassword ? 'default' : 'pointer'
                            }}
                            onClick={() => !isChangingPassword && setIsChangingPassword(true)}
                        >
                            <div
                                style={{
                                    width: '28px',
                                    height: '28px',
                                    borderRadius: '6px',
                                    backgroundColor: 'var(--bg-secondary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                            >
                                <Key size={14} color="var(--text-secondary)" />
                            </div>
                            {!isChangingPassword ? (
                                <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                                    Change password
                                </span>
                            ) : (
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                    {passwordSuccess ? (
                                        <div style={{ color: '#22c55e', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                                            <Check size={14} /> Password changed!
                                        </div>
                                    ) : (
                                        <>
                                            <input
                                                type="password"
                                                value={currentPassword}
                                                onChange={(e) => { setCurrentPassword(e.target.value); setPasswordError(''); }}
                                                placeholder="Current password"
                                                autoFocus
                                                style={{
                                                    padding: '0.4rem 0.6rem',
                                                    borderRadius: '6px',
                                                    border: `1px solid ${passwordError ? '#ef4444' : 'var(--border)'}`,
                                                    backgroundColor: 'var(--bg-secondary)',
                                                    color: 'var(--text-primary)',
                                                    fontSize: '0.8rem',
                                                    outline: 'none'
                                                }}
                                            />
                                            <input
                                                type="password"
                                                value={newPassword}
                                                onChange={(e) => { setNewPassword(e.target.value); setPasswordError(''); }}
                                                placeholder="New password (min 8 chars)"
                                                style={{
                                                    padding: '0.4rem 0.6rem',
                                                    borderRadius: '6px',
                                                    border: `1px solid ${passwordError ? '#ef4444' : 'var(--border)'}`,
                                                    backgroundColor: 'var(--bg-secondary)',
                                                    color: 'var(--text-primary)',
                                                    fontSize: '0.8rem',
                                                    outline: 'none'
                                                }}
                                            />
                                            <div style={{ display: 'flex', gap: '0.4rem' }}>
                                                <button
                                                    onClick={handleChangePassword}
                                                    disabled={isPasswordLoading}
                                                    style={{
                                                        flex: 1,
                                                        padding: '0.4rem',
                                                        borderRadius: '6px',
                                                        border: 'none',
                                                        backgroundColor: 'var(--accent)',
                                                        color: 'white',
                                                        cursor: isPasswordLoading ? 'not-allowed' : 'pointer',
                                                        fontSize: '0.75rem',
                                                        opacity: isPasswordLoading ? 0.7 : 1
                                                    }}
                                                >
                                                    {isPasswordLoading ? 'Saving...' : 'Save'}
                                                </button>
                                                <button
                                                    onClick={handleCancelPasswordChange}
                                                    style={{
                                                        padding: '0.4rem 0.6rem',
                                                        borderRadius: '6px',
                                                        border: '1px solid var(--border)',
                                                        backgroundColor: 'transparent',
                                                        color: 'var(--text-secondary)',
                                                        cursor: 'pointer',
                                                        fontSize: '0.75rem'
                                                    }}
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                            {passwordError && (
                                                <div style={{ color: '#ef4444', fontSize: '0.7rem' }}>
                                                    {passwordError}
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Change Theme */}
                    <div
                        style={{
                            padding: '0.5rem',
                            borderRadius: '8px',
                            marginBottom: '0.125rem',
                            cursor: 'pointer'
                        }}
                        onClick={toggleTheme}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-secondary)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                            <div
                                style={{
                                    width: '28px',
                                    height: '28px',
                                    borderRadius: '6px',
                                    backgroundColor: 'var(--bg-secondary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                            >
                                <Palette size={14} color="var(--text-secondary)" />
                            </div>
                            <div style={{ flex: 1 }}>
                                <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                                    Theme
                                </span>
                            </div>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
                                {theme}
                            </span>
                        </div>
                    </div>

                    {/* Private Account */}
                    <div
                        style={{
                            padding: '0.5rem',
                            borderRadius: '8px',
                            marginBottom: '0.125rem',
                            cursor: isPrivacyLoading ? 'not-allowed' : 'pointer',
                            opacity: isPrivacyLoading ? 0.7 : 1
                        }}
                        onClick={() => !isPrivacyLoading && togglePrivacy()}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-secondary)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                            <div
                                style={{
                                    width: '28px',
                                    height: '28px',
                                    borderRadius: '6px',
                                    backgroundColor: 'var(--bg-secondary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                            >
                                <Lock size={14} color="var(--text-secondary)" />
                            </div>
                            <div style={{ flex: 1 }}>
                                <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                                    Private account
                                </span>
                            </div>
                            <div
                                style={{
                                    width: '36px',
                                    height: '20px',
                                    borderRadius: '10px',
                                    backgroundColor: isPrivate ? 'var(--accent)' : 'var(--bg-secondary)',
                                    border: isPrivate ? 'none' : '1px solid var(--border)',
                                    position: 'relative',
                                    transition: 'background-color 0.2s'
                                }}
                            >
                                <div
                                    style={{
                                        width: '16px',
                                        height: '16px',
                                        borderRadius: '50%',
                                        backgroundColor: isPrivate ? 'white' : 'var(--text-secondary)',
                                        position: 'absolute',
                                        top: '2px',
                                        left: isPrivate ? '18px' : '2px',
                                        transition: 'left 0.2s, background-color 0.2s'
                                    }}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Logout */}
                    <div
                        style={{
                            padding: '0.5rem',
                            borderRadius: '8px',
                            cursor: 'pointer'
                        }}
                        onClick={onLogout}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-secondary)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                            <div
                                style={{
                                    width: '28px',
                                    height: '28px',
                                    borderRadius: '6px',
                                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                            >
                                <LogOut size={14} color="#ef4444" />
                            </div>
                            <span style={{ fontSize: '0.85rem', color: '#ef4444' }}>
                                Logout
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
