import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
    ArrowLeft, User, Key, Lock, Camera, Trash2, X, 
    LogOut, AlertTriangle, ChevronRight, Pencil 
} from 'lucide-react';
import { useAuth } from '../store';
import { api } from '../services/api';
import { VALIDATION, VALIDATION_MESSAGES } from '../constants/validation';
import { Toast } from './ui';
import { APP_ROUTES } from '../constants/routes';

export const SettingsPage: React.FC = () => {
    const navigate = useNavigate();
    const { user, logout, updateUsername, updateProfilePic, updateBio } = useAuth();
    
    // Dialog states
    const [showUsernameDialog, setShowUsernameDialog] = useState(false);
    const [showPasswordDialog, setShowPasswordDialog] = useState(false);
    const [showLogoutDialog, setShowLogoutDialog] = useState(false);
    const [showFullscreenPic, setShowFullscreenPic] = useState(false);
    const [showPicDialog, setShowPicDialog] = useState(false);
    const [showBioDialog, setShowBioDialog] = useState(false);
    
    // Profile picture state
    const [isUploadingPic, setIsUploadingPic] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    
    // Privacy state
    const [isPrivate, setIsPrivate] = useState(false);
    const [isPrivacyLoading, setIsPrivacyLoading] = useState(false);
    
    // Toast
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
    
    // Page animation
    const [isExiting, setIsExiting] = useState(false);

    // Fetch privacy setting on mount
    useEffect(() => {
        if (user) {
            api.get('/get-privacy').then(res => {
                if (res.success) {
                    setIsPrivate(res.is_private);
                }
            });
            api.get('/profile').then(res => {
                if (res.success) {
                    if (res.profile_pic) {
                        updateProfilePic(res.profile_pic);
                    }
                    if (res.bio !== undefined) {
                        updateBio(res.bio);
                    }
                }
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!user) {
        navigate(APP_ROUTES.LOGIN);
        return null;
    }

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

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const ext = file.name.toLowerCase().split('.').pop();
        
        if (!VALIDATION.ALLOWED_IMAGE_TYPES.includes(file.type) && !VALIDATION.ALLOWED_IMAGE_EXTENSIONS.includes(ext || '')) {
            setToast({ message: VALIDATION_MESSAGES.FILE_TYPE_ERROR, type: 'error' });
            return;
        }

        if (file.size > VALIDATION.MAX_FILE_SIZE) {
            setToast({ message: VALIDATION_MESSAGES.FILE_SIZE_ERROR, type: 'error' });
            return;
        }

        setIsUploadingPic(true);
        setShowPicDialog(false);

        try {
            const res = await api.uploadFile('/profile/upload-picture', file);
            if (res.success) {
                updateProfilePic(res.profile_pic ?? null);
                setToast({ message: 'Profile picture updated!', type: 'success' });
            } else {
                setToast({ message: res.error || 'Failed to upload image', type: 'error' });
            }
        } catch (err) {
            setToast({ message: 'Failed to upload image', type: 'error' });
        } finally {
            setIsUploadingPic(false);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        }
    };

    const handleRemovePicture = async () => {
        setIsUploadingPic(true);
        setShowPicDialog(false);

        try {
            const res = await api.delete('/profile/picture');
            if (res.success) {
                updateProfilePic(null);
                setToast({ message: 'Profile picture removed', type: 'success' });
            } else {
                setToast({ message: res.error || 'Failed to remove image', type: 'error' });
            }
        } catch (err) {
            setToast({ message: 'Failed to remove image', type: 'error' });
        } finally {
            setIsUploadingPic(false);
        }
    };

    const handleLogout = () => {
        logout();
        navigate(APP_ROUTES.LOGIN);
    };

    const handleBack = () => {
        setIsExiting(true);
        setTimeout(() => {
            navigate(-1);
        }, 200);
    };

    return (
        <>
            <style>{`
                @keyframes slideInFromRight {
                    from {
                        transform: translateX(100%);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
                @keyframes slideOutToRight {
                    from {
                        transform: translateX(0);
                        opacity: 1;
                    }
                    to {
                        transform: translateX(100%);
                        opacity: 0;
                    }
                }
            `}</style>
            <div 
                className="container" 
                style={{ 
                    maxWidth: '480px', 
                    padding: '0.5rem 1rem', 
                    paddingBottom: '2rem',
                    animation: isExiting ? 'slideOutToRight 0.2s ease-in forwards' : 'slideInFromRight 0.25s ease-out'
                }}
            >
            {/* Header */}
            <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '0.5rem',
                marginBottom: '0.75rem'
            }}>
                <button
                    onClick={handleBack}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        padding: '0.25rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '8px',
                        transition: 'background-color 0.2s'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                    <ArrowLeft size={20} />
                </button>
                <h1 style={{ 
                    fontSize: '1.25rem', 
                    fontWeight: 700, 
                    color: 'var(--text-primary)',
                    margin: 0
                }}>
                    Settings
                </h1>
            </div>

            {/* Profile Section */}
            <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {/* Profile Picture */}
                    <div style={{ position: 'relative' }}>
                        <div
                            style={{
                                width: '56px',
                                height: '56px',
                                borderRadius: '50%',
                                backgroundColor: 'var(--avatar-bg)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 700,
                                fontSize: '1.5rem',
                                color: 'var(--text-primary)',
                                textTransform: 'uppercase',
                                overflow: 'hidden',
                                cursor: user.profilePic ? 'zoom-in' : 'pointer',
                                border: '2px solid var(--border)',
                                transition: 'border-color 0.2s'
                            }}
                            onClick={() => {
                                if (user.profilePic) {
                                    setShowFullscreenPic(true);
                                } else {
                                    setShowPicDialog(true);
                                }
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--accent)'}
                            onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--border)'}
                        >
                            {isUploadingPic ? (
                                <div style={{
                                    width: '20px',
                                    height: '20px',
                                    border: '2px solid var(--text-secondary)',
                                    borderTopColor: 'var(--accent)',
                                    borderRadius: '50%',
                                    animation: 'spin 1s linear infinite'
                                }} />
                            ) : user.profilePic ? (
                                <img
                                    src={user.profilePic}
                                    alt={user.username}
                                    style={{
                                        width: '100%',
                                        height: '100%',
                                        objectFit: 'cover'
                                    }}
                                />
                            ) : (
                                user.username.charAt(0)
                            )}
                        </div>
                        
                        {/* Camera icon overlay */}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowPicDialog(true);
                            }}
                            style={{
                                position: 'absolute',
                                bottom: '-2px',
                                right: '-2px',
                                width: '22px',
                                height: '22px',
                                borderRadius: '50%',
                                backgroundColor: 'var(--accent)',
                                border: '2px solid var(--bg-primary)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer'
                            }}
                        >
                            <Camera size={10} color="white" />
                        </button>
                    </div>

                    <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                        <h2 style={{ 
                            fontSize: '1rem', 
                            fontWeight: 600, 
                            color: 'var(--text-primary)',
                            margin: 0
                        }}>
                            @{user.username}
                        </h2>
                        <div 
                            onClick={() => setShowBioDialog(true)}
                            style={{ 
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.35rem',
                                marginTop: '0.25rem',
                                cursor: 'pointer',
                                maxWidth: '100%'
                            }}
                        >
                            <p style={{ 
                                fontSize: '0.8rem', 
                                color: user.bio ? 'var(--text-secondary)' : 'var(--accent)',
                                margin: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                flex: 1,
                                minWidth: 0
                            }}>
                                {user.bio || '+ Add bio'}
                            </p>
                            <Pencil size={12} color="var(--accent)" style={{ flexShrink: 0 }} />
                        </div>
                    </div>
                </div>

                {/* Hidden file input */}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                    onChange={handleFileSelect}
                    style={{ display: 'none' }}
                />
            </div>

            {/* Account Settings */}
            <div className="card" style={{ padding: 0, overflow: 'hidden', border: '1px solid var(--border)' }}>
                <SettingsItem
                    icon={<User size={18} />}
                    label="Username"
                    value={`@${user.username}`}
                    onClick={() => setShowUsernameDialog(true)}
                    showBorder
                    iconColor="var(--text-secondary)"
                    iconBg="var(--icon-bg-muted)"
                />
                
                <SettingsItem
                    icon={<Key size={18} />}
                    label="Password"
                    value="••••••••"
                    onClick={() => setShowPasswordDialog(true)}
                    showBorder
                    iconColor="var(--text-secondary)"
                    iconBg="var(--icon-bg-muted)"
                />

                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0.75rem 1rem',
                    gap: '0.75rem',
                    borderBottom: '1px solid var(--border)'
                }}>
                    <div style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--icon-bg-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-secondary)'
                    }}>
                        <Lock size={16} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ 
                            fontSize: '0.875rem', 
                            fontWeight: 500, 
                            color: 'var(--text-primary)' 
                        }}>
                            Private account
                        </div>
                    </div>
                    <button
                        onClick={togglePrivacy}
                        disabled={isPrivacyLoading}
                        style={{
                            width: '44px',
                            height: '24px',
                            borderRadius: '12px',
                            border: 'none',
                            backgroundColor: isPrivate ? '#0095f6' : 'var(--border)',
                            cursor: 'pointer',
                            position: 'relative',
                            transition: 'background-color 0.2s'
                        }}
                    >
                        <div style={{
                            width: '18px',
                            height: '18px',
                            borderRadius: '50%',
                            backgroundColor: 'white',
                            position: 'absolute',
                            top: '3px',
                            left: isPrivate ? '23px' : '3px',
                            transition: 'left 0.2s',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                        }} />
                    </button>
                </div>

                <button
                    onClick={() => setShowLogoutDialog(true)}
                    style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        padding: '0.75rem 1rem',
                        gap: '0.75rem',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left'
                    }}
                >
                    <div style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '8px',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#ef4444'
                    }}>
                        <LogOut size={16} />
                    </div>
                    <span style={{ 
                        fontSize: '0.875rem', 
                        fontWeight: 500, 
                        color: '#ef4444' 
                    }}>
                        Log out
                    </span>
                </button>
            </div>

            {/* Profile Picture Dialog */}
            <ProfilePictureDialog
                isOpen={showPicDialog}
                onClose={() => setShowPicDialog(false)}
                hasProfilePic={!!user.profilePic}
                onUploadClick={() => fileInputRef.current?.click()}
                onRemoveClick={handleRemovePicture}
            />

            {/* Username Dialog */}
            <UsernameDialog
                isOpen={showUsernameDialog}
                onClose={() => setShowUsernameDialog(false)}
                currentUsername={user.username}
                onSuccess={(newUsername) => {
                    updateUsername(newUsername);
                    setToast({ message: 'Username updated!', type: 'success' });
                }}
            />

            {/* Password Dialog */}
            <PasswordDialog
                isOpen={showPasswordDialog}
                onClose={() => setShowPasswordDialog(false)}
                onSuccess={() => {
                    setToast({ message: 'Password changed successfully!', type: 'success' });
                }}
            />

            {/* Bio Dialog */}
            <BioDialog
                isOpen={showBioDialog}
                onClose={() => setShowBioDialog(false)}
                currentBio={user.bio || ''}
                onSuccess={(newBio) => {
                    updateBio(newBio || null);
                    setToast({ message: 'Bio updated!', type: 'success' });
                }}
            />

            {/* Logout Confirmation Dialog */}
            <LogoutDialog
                isOpen={showLogoutDialog}
                onClose={() => setShowLogoutDialog(false)}
                onConfirm={handleLogout}
            />

            {/* Fullscreen Profile Picture */}
            {showFullscreenPic && user.profilePic && (
                <div
                    onClick={() => setShowFullscreenPic(false)}
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.95)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                        cursor: 'zoom-out',
                        animation: 'fadeIn 0.2s ease-out'
                    }}
                >
                    <button
                        onClick={() => setShowFullscreenPic(false)}
                        style={{
                            position: 'absolute',
                            top: '20px',
                            right: '20px',
                            width: '40px',
                            height: '40px',
                            borderRadius: '50%',
                            border: 'none',
                            backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            color: 'white',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                    >
                        <X size={24} />
                    </button>
                    <img
                        src={user.profilePic}
                        alt={user.username}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            maxWidth: '90vw',
                            maxHeight: '90vh',
                            objectFit: 'contain',
                            borderRadius: '8px',
                            cursor: 'default',
                            animation: 'scaleIn 0.2s ease-out'
                        }}
                    />
                    <div style={{
                        position: 'absolute',
                        bottom: '30px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        color: 'white',
                        fontSize: '1rem',
                        fontWeight: 500,
                        padding: '8px 16px',
                        backgroundColor: 'rgba(0, 0, 0, 0.5)',
                        borderRadius: '20px'
                    }}>
                        @{user.username}
                    </div>
                </div>
            )}

            {/* Toast */}
            {toast && (
                <Toast
                    message={toast.message}
                    type={toast.type}
                    onClose={() => setToast(null)}
                />
            )}
        </div>
        </>
    );
};

// Settings Item Component
const SettingsItem: React.FC<{
    icon: React.ReactNode;
    label: string;
    value?: string;
    onClick: () => void;
    showBorder?: boolean;
    iconColor?: string;
    iconBg?: string;
}> = ({ icon, label, value, onClick, showBorder, iconColor = '#3b82f6', iconBg = 'rgba(59, 130, 246, 0.1)' }) => (
    <button
        onClick={onClick}
        style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            padding: '0.75rem 1rem',
            gap: '0.75rem',
            background: 'none',
            border: 'none',
            borderBottom: showBorder ? '1px solid var(--border)' : 'none',
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'background-color 0.2s'
        }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
    >
        <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            backgroundColor: iconBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: iconColor
        }}>
            {icon}
        </div>
        <div style={{ flex: 1 }}>
            <div style={{ 
                fontSize: '0.875rem', 
                fontWeight: 500, 
                color: 'var(--text-primary)' 
            }}>
                {label}
            </div>
            {value && (
                <div style={{ 
                    fontSize: '0.75rem', 
                    color: 'var(--text-secondary)' 
                }}>
                    {value}
                </div>
            )}
        </div>
        <ChevronRight size={18} color="var(--text-secondary)" />
    </button>
);

// Profile Picture Dialog
const ProfilePictureDialog: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    hasProfilePic: boolean;
    onUploadClick: () => void;
    onRemoveClick: () => void;
}> = ({ isOpen, onClose, hasProfilePic, onUploadClick, onRemoveClick }) => {
    if (!isOpen) return null;

    return (
        <DialogWrapper onClose={onClose}>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '1rem'
            }}>
                <h3 style={{ 
                    margin: 0, 
                    fontSize: '1.125rem', 
                    fontWeight: 600,
                    color: 'var(--text-primary)'
                }}>
                    Profile photo
                </h3>
                <button
                    type="button"
                    onClick={onClose}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        padding: '0.25rem'
                    }}
                >
                    <X size={20} />
                </button>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                    onClick={() => {
                        onUploadClick();
                        onClose();
                    }}
                    style={{
                        flex: 1,
                        padding: '0.625rem 1.25rem',
                        borderRadius: '8px',
                        border: 'none',
                        backgroundColor: '#0095f6',
                        color: '#ffffff',
                        fontSize: '0.875rem',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.5rem',
                        fontWeight: 500
                    }}
                >
                    <Camera size={16} />
                    {hasProfilePic ? 'Change' : 'Upload'}
                </button>
                {hasProfilePic && (
                    <button
                        onClick={onRemoveClick}
                        style={{
                            flex: 1,
                            padding: '0.625rem 1.25rem',
                            borderRadius: '8px',
                            border: '1px solid #ef4444',
                            backgroundColor: 'transparent',
                            color: '#ef4444',
                            fontSize: '0.875rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.5rem',
                            fontWeight: 500
                        }}
                    >
                        <Trash2 size={16} />
                        Remove
                    </button>
                )}
            </div>
        </DialogWrapper>
    );
};

// Username Dialog
const UsernameDialog: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    currentUsername: string;
    onSuccess: (newUsername: string) => void;
}> = ({ isOpen, onClose, currentUsername, onSuccess }) => {
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
        } catch (err) {
            setError('Failed to update username');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <DialogWrapper onClose={onClose}>
            <form onSubmit={handleSubmit}>
                <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    marginBottom: '1rem'
                }}>
                    <h3 style={{ 
                        margin: 0, 
                        fontSize: '1.125rem', 
                        fontWeight: 600,
                        color: 'var(--text-primary)'
                    }}>
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
                            padding: '0.25rem'
                        }}
                    >
                        <X size={20} />
                    </button>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                    <label style={{ 
                        fontSize: '0.875rem', 
                        color: 'var(--text-secondary)',
                        display: 'block',
                        marginBottom: '0.5rem'
                    }}>
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
                            fontSize: '0.9375rem',
                            outline: 'none'
                        }}
                    />
                    {error && (
                        <p style={{ 
                            color: '#ef4444', 
                            fontSize: '0.75rem', 
                            marginTop: '0.5rem',
                            margin: '0.5rem 0 0 0'
                        }}>
                            {error}
                        </p>
                    )}
                </div>

                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
                    <button type="button" onClick={onClose} className="btn btn-outline" style={{ flex: 1, padding: '0.6rem', fontSize: '0.85rem' }}>
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
                            opacity: isLoading ? 0.7 : 1
                        }}
                    >
                        {isLoading ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </form>
        </DialogWrapper>
    );
};

// Password Dialog
const PasswordDialog: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}> = ({ isOpen, onClose, onSuccess }) => {
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setCurrentPassword('');
            setNewPassword('');
            setError('');
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        
        if (!currentPassword || !newPassword) {
            setError('All fields are required');
            return;
        }
        if (newPassword.length < 8) {
            setError('Password must be at least 8 characters');
            return;
        }

        setIsLoading(true);
        try {
            const res = await api.post('/change-password', {
                current_password: currentPassword,
                new_password: newPassword
            });
            if (res.success) {
                onSuccess();
                onClose();
            } else {
                setError(res.error || 'Failed to change password');
            }
        } catch (err) {
            setError('Failed to change password');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <DialogWrapper onClose={onClose}>
            <form onSubmit={handleSubmit}>
                <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    marginBottom: '1rem'
                }}>
                    <h3 style={{ 
                        margin: 0, 
                        fontSize: '1.125rem', 
                        fontWeight: 600,
                        color: 'var(--text-primary)'
                    }}>
                        Change password
                    </h3>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            padding: '0.25rem'
                        }}
                    >
                        <X size={20} />
                    </button>
                </div>

                <div style={{ marginBottom: '0.75rem' }}>
                    <label style={{ 
                        fontSize: '0.875rem', 
                        color: 'var(--text-secondary)',
                        display: 'block',
                        marginBottom: '0.5rem'
                    }}>
                        Current password
                    </label>
                    <input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => {
                            setCurrentPassword(e.target.value);
                            setError('');
                        }}
                        placeholder="Enter current password"
                        autoFocus
                        style={{
                            width: '100%',
                            padding: '0.75rem',
                            borderRadius: '8px',
                            border: '1px solid var(--border)',
                            backgroundColor: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            fontSize: '0.9375rem',
                            outline: 'none'
                        }}
                    />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                    <label style={{ 
                        fontSize: '0.875rem', 
                        color: 'var(--text-secondary)',
                        display: 'block',
                        marginBottom: '0.5rem'
                    }}>
                        New password
                    </label>
                    <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => {
                            setNewPassword(e.target.value);
                            setError('');
                        }}
                        placeholder="Enter new password"
                        style={{
                            width: '100%',
                            padding: '0.75rem',
                            borderRadius: '8px',
                            border: `1px solid ${error ? '#ef4444' : 'var(--border)'}`,
                            backgroundColor: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            fontSize: '0.9375rem',
                            outline: 'none'
                        }}
                    />
                    {error && (
                        <p style={{ 
                            color: '#ef4444', 
                            fontSize: '0.75rem', 
                            marginTop: '0.5rem',
                            margin: '0.5rem 0 0 0'
                        }}>
                            {error}
                        </p>
                    )}
                </div>

                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
                    <button type="button" onClick={onClose} className="btn btn-outline" style={{ flex: 1, padding: '0.6rem', fontSize: '0.85rem' }}>
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
                            opacity: isLoading ? 0.7 : 1
                        }}
                    >
                        {isLoading ? 'Saving...' : 'Update'}
                    </button>
                </div>
            </form>
        </DialogWrapper>
    );
};

// Bio Dialog
const BioDialog: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    currentBio: string;
    onSuccess: (newBio: string) => void;
}> = ({ isOpen, onClose, currentBio, onSuccess }) => {
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
        } catch (err) {
            setError('Failed to update bio');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <DialogWrapper onClose={onClose}>
            <form onSubmit={handleSubmit}>
                <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    marginBottom: '1rem'
                }}>
                    <h3 style={{ 
                        margin: 0, 
                        fontSize: '1.125rem', 
                        fontWeight: 600,
                        color: 'var(--text-primary)'
                    }}>
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
                            padding: '0.25rem'
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
                            fontFamily: 'inherit'
                        }}
                    />
                    <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginTop: '0.5rem'
                    }}>
                        <span style={{ 
                            fontSize: '0.75rem', 
                            color: bio.length > 150 ? '#ef4444' : 'var(--text-secondary)' 
                        }}>
                            {bio.length}/150
                        </span>
                        {error && (
                            <span style={{ 
                                color: '#ef4444', 
                                fontSize: '0.75rem'
                            }}>
                                {error}
                            </span>
                        )}
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
                    <button type="button" onClick={onClose} className="btn btn-outline" style={{ flex: 1, padding: '0.6rem', fontSize: '0.85rem' }}>
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
                            opacity: isLoading ? 0.7 : 1
                        }}
                    >
                        {isLoading ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </form>
        </DialogWrapper>
    );
};

// Logout Confirmation Dialog
const LogoutDialog: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
}> = ({ isOpen, onClose, onConfirm }) => {
    if (!isOpen) return null;

    return (
        <DialogWrapper onClose={onClose}>
            <div style={{ textAlign: 'center' }}>
                <div style={{
                    width: '56px',
                    height: '56px',
                    borderRadius: '50%',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 1rem'
                }}>
                    <AlertTriangle size={28} color="#ef4444" />
                </div>
                
                <h3 style={{ 
                    margin: '0 0 0.5rem', 
                    fontSize: '1.125rem', 
                    fontWeight: 600,
                    color: 'var(--text-primary)'
                }}>
                    Log out?
                </h3>
                
                <p style={{ 
                    margin: '0 0 1.5rem', 
                    fontSize: '0.875rem', 
                    color: 'var(--text-secondary)' 
                }}>
                    Are you sure you want to log out of your account?
                </p>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                        onClick={onClose}
                        style={{
                            flex: 1,
                            padding: '0.75rem',
                            borderRadius: '8px',
                            border: '1px solid var(--border)',
                            backgroundColor: 'transparent',
                            color: 'var(--text-primary)',
                            fontSize: '0.875rem',
                            fontWeight: 500,
                            cursor: 'pointer'
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        style={{
                            flex: 1,
                            padding: '0.75rem',
                            borderRadius: '8px',
                            border: 'none',
                            backgroundColor: '#ef4444',
                            color: 'white',
                            fontSize: '0.875rem',
                            fontWeight: 500,
                            cursor: 'pointer'
                        }}
                    >
                        Log out
                    </button>
                </div>
            </div>
        </DialogWrapper>
    );
};

// Dialog Wrapper Component
const DialogWrapper: React.FC<{
    children: React.ReactNode;
    onClose: () => void;
}> = ({ children, onClose }) => (
    <div
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
            overflowY: 'auto'
        }}
    >
        <div
            className="card"
            style={{
                width: '100%',
                maxWidth: '340px',
                padding: '1.25rem',
                animation: 'modalSlideIn 0.2s ease-out'
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
