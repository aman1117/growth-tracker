import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings, Sun, Moon, Monitor } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

export const ProfileDropdown: React.FC = () => {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { theme, setTheme } = useTheme();
    const [isOpen, setIsOpen] = useState(false);
    const [isClosing, setIsClosing] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const closeDropdown = () => {
        setIsClosing(true);
        setTimeout(() => {
            setIsOpen(false);
            setIsClosing(false);
        }, 150);
    };

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                closeDropdown();
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    if (!user) return null;

    return (
        <div ref={dropdownRef} style={{ position: 'relative' }}>
            {/* Profile Pill Button */}
            <button
                onClick={() => isOpen ? closeDropdown() : setIsOpen(true)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    borderRadius: '50%',
                    border: 'none',
                    backgroundColor: 'transparent',
                    cursor: 'pointer',
                    width: '36px',
                    height: '36px'
                }}
            >
                <div
                    style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--avatar-bg)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 700,
                        fontSize: '0.875rem',
                        color: 'var(--text-primary)',
                        textTransform: 'uppercase',
                        overflow: 'hidden'
                    }}
                >
                    {user.profilePic ? (
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
            </button>

            {/* Dropdown Menu */}
            {isOpen && (
                <div
                    style={{
                        position: 'absolute',
                        top: 'calc(100% + 8px)',
                        right: 0,
                        width: '180px',
                        backgroundColor: 'var(--bg-secondary)',
                        borderRadius: '12px',
                        border: '1px solid var(--border-strong)',
                        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
                        overflow: 'hidden',
                        zIndex: 100,
                        animation: isClosing ? 'dropdownSlideOut 0.15s ease-out forwards' : 'dropdownSlideIn 0.15s ease-out'
                    }}
                >
                    <style>{`
                        @keyframes dropdownSlideIn {
                            from {
                                opacity: 0;
                                transform: translateY(-8px);
                            }
                            to {
                                opacity: 1;
                                transform: translateY(0);
                            }
                        }
                        @keyframes dropdownSlideOut {
                            from {
                                opacity: 1;
                                transform: translateY(0);
                            }
                            to {
                                opacity: 0;
                                transform: translateY(-8px);
                            }
                        }
                    `}</style>

                    {/* Settings Option */}
                    <button
                        onClick={() => {
                            closeDropdown();
                            navigate('/settings');
                        }}
                        style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.75rem 1rem',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            color: 'var(--text-primary)',
                            fontSize: '0.875rem',
                            fontWeight: 500,
                            textAlign: 'left',
                            transition: 'background-color 0.15s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                        <Settings size={18} color="var(--text-secondary)" />
                        Settings
                    </button>

                    {/* Divider */}
                    <div style={{ 
                        height: '1px', 
                        backgroundColor: 'var(--border)',
                        margin: '0.25rem 0'
                    }} />

                    {/* Theme Options */}
                    <div style={{ 
                        display: 'flex', 
                        gap: '0.5rem', 
                        padding: '0.5rem 0.75rem 0.75rem'
                    }}>
                        <ThemeButton
                            icon={<Sun size={14} />}
                            isActive={theme === 'light'}
                            onClick={() => setTheme('light')}
                        />
                        <ThemeButton
                            icon={<Moon size={14} />}
                            isActive={theme === 'dark'}
                            onClick={() => setTheme('dark')}
                        />
                        <ThemeButton
                            icon={<Monitor size={14} />}
                            isActive={theme === 'system'}
                            onClick={() => setTheme('system')}
                        />
                    </div>
                </div>
            )}
        </div>
    );
};

// Theme Button Component
const ThemeButton: React.FC<{
    icon: React.ReactNode;
    isActive: boolean;
    onClick: () => void;
}> = ({ icon, isActive, onClick }) => (
    <button
        onClick={onClick}
        style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0.5rem',
            borderRadius: '8px',
            border: isActive ? '1px solid var(--accent)' : '1px solid transparent',
            backgroundColor: isActive ? 'rgba(var(--accent-rgb), 0.1)' : 'transparent',
            cursor: 'pointer',
            transition: 'all 0.15s',
            color: isActive ? 'var(--accent)' : 'var(--text-secondary)'
        }}
    >
        {icon}
    </button>
);
