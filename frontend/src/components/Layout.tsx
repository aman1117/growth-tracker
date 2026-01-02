import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, Search, User as UserIcon, X, Settings2, Lock } from 'lucide-react';
import { api } from '../utils/api';
import { ProfileDialog } from './ProfileDialog';
import { ThemeToggle } from './ThemeToggle';

interface SearchResult {
    id: number;
    username: string;
    email: string;
    profile_pic?: string;
    is_private: boolean;
}

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    // Search State
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const searchInputRef = useRef<HTMLInputElement>(null);
    
    // Profile Dialog State
    const [isProfileOpen, setIsProfileOpen] = useState(false);

    const handleLogout = () => {
        setIsProfileOpen(false);
        logout();
        navigate('/login');
    };

    // Focus input when search opens
    useEffect(() => {
        if (isSearchOpen && searchInputRef.current) {
            searchInputRef.current.focus();
        }
    }, [isSearchOpen]);

    // Debounced Search
    useEffect(() => {
        const timer = setTimeout(async () => {
            if (searchQuery.trim().length > 0) {
                try {
                    const res = await api.post('/users', { username: searchQuery });
                    if (res.success) {
                        setSearchResults(res.data);
                    }
                } catch (error) {
                    console.error('Search failed:', error);
                }
            } else {
                setSearchResults([]);
            }
        }, 500);

        return () => clearTimeout(timer);
    }, [searchQuery]);

    const handleUserClick = (username: string) => {
        navigate(`/user/${username}`);
        setIsSearchOpen(false);
        setSearchQuery('');
        setSearchResults([]);
    };

    return (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
            <header style={{
                borderBottom: '1px solid var(--border)',
                padding: '0.75rem 0',
                backgroundColor: 'var(--header-bg)',
                backdropFilter: 'blur(12px)', // Glassmorphism
                WebkitBackdropFilter: 'blur(12px)',
                position: 'sticky',
                top: 0,
                zIndex: 50,
                transition: 'background-color 0.3s ease, border-color 0.3s ease'
            }}>
                <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 1.5rem' }}>
                    <div
                        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
                        onClick={() => navigate('/')}
                    >
                        <div style={{
                            background: 'var(--logo-bg)',
                            color: 'var(--logo-color)',
                            padding: '0.4rem',
                            borderRadius: '8px',
                            display: 'flex',
                            transition: 'background-color 0.3s ease'
                        }}>
                            <TrendingUp size={22} strokeWidth={2.5} color="var(--logo-color)" />
                        </div>
                    </div>

                    {user && (
                        <div className="flex items-center gap-4">
                            <button
                                onClick={() => {
                                    window.dispatchEvent(new CustomEvent('toggleEditMode'));
                                }}
                                className="btn-outline"
                                style={{
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)',
                                    borderRadius: '50%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: 'var(--text-secondary)',
                                    width: '36px',
                                    height: '36px'
                                }}
                                title="Customize tiles"
                            >
                                <Settings2 size={16} />
                            </button>
                            <button
                                onClick={() => setIsSearchOpen(true)}
                                className="btn-outline"
                                style={{
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)',
                                    borderRadius: '50%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: 'var(--text-secondary)',
                                    width: '36px',
                                    height: '36px'
                                }}
                            >
                                <Search size={16} />
                            </button>

                            <button
                                onClick={() => setIsProfileOpen(true)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    padding: '0.25rem 0.75rem 0.25rem 0.25rem',
                                    borderRadius: '20px',
                                    border: '1px solid var(--border)',
                                    backgroundColor: 'transparent',
                                    cursor: 'pointer',
                                    transition: 'background-color 0.2s'
                                }}
                                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-secondary)')}
                                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                            >
                                <div
                                    style={{
                                        width: '28px',
                                        height: '28px',
                                        borderRadius: '50%',
                                        backgroundColor: 'var(--avatar-bg)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontWeight: 700,
                                        fontSize: '0.75rem',
                                        color: 'var(--text-primary)',
                                        textTransform: 'uppercase',
                                        transition: 'background-color 0.3s ease'
                                    }}
                                >
                                    {user.username.charAt(0)}
                                </div>
                                <span style={{
                                    fontSize: '0.85rem',
                                    fontWeight: 500,
                                    color: 'var(--text-primary)'
                                }}>
                                    {user.username}
                                </span>
                            </button>
                        </div>
                    )}
                    
                    {/* Show theme toggle even when not logged in */}
                    {!user && (
                        <ThemeToggle />
                    )}
                </div>
            </header>
            <main style={{ flex: 1, paddingTop: '0.5rem' }}>
                {children}
            </main>

            {/* Search Modal */}
            {isSearchOpen && (
                <div style={{
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
                    paddingTop: '10vh'
                }} onClick={() => setIsSearchOpen(false)}>
                    <div style={{
                        width: '100%',
                        maxWidth: '320px',
                        background: 'var(--glass-bg)',
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        borderRadius: '14px',
                        boxShadow: 'var(--glass-shadow)',
                        border: '1px solid var(--glass-border)',
                        overflow: 'hidden',
                        margin: '0 1rem'
                    }} onClick={e => e.stopPropagation()}>
                        <div style={{
                            padding: '0.75rem 1rem',
                            borderBottom: '1px solid var(--glass-border)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.6rem'
                        }}>
                            <Search size={16} color="var(--text-secondary)" />
                            <input
                                ref={searchInputRef}
                                type="text"
                                placeholder="Search users..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                style={{
                                    border: 'none',
                                    background: 'transparent',
                                    outline: 'none',
                                    fontSize: '0.9rem',
                                    color: 'var(--text-primary)',
                                    width: '100%',
                                    fontWeight: 500
                                }}
                            />
                            <button
                                onClick={() => {
                                    if (searchQuery.length > 0) {
                                        setSearchQuery('');
                                        searchInputRef.current?.focus();
                                    } else {
                                        setIsSearchOpen(false);
                                    }
                                }}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--text-secondary)',
                                    cursor: 'pointer',
                                    padding: '0.25rem'
                                }}
                            >
                                <X size={16} />
                            </button>
                        </div>

                        {searchResults.length > 0 && (
                            <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                                {searchResults.map((result) => (
                                    <div
                                        key={result.id}
                                        onClick={() => handleUserClick(result.username)}
                                        style={{
                                            padding: '0.5rem 0.75rem',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.6rem',
                                            borderBottom: '1px solid var(--border)',
                                            transition: 'background-color 0.2s'
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                    >
                                        <div style={{
                                            width: '32px',
                                            height: '32px',
                                            borderRadius: '50%',
                                            backgroundColor: 'var(--bg-secondary)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            overflow: 'hidden'
                                        }}>
                                            {result.profile_pic ? (
                                                <img 
                                                    src={result.profile_pic} 
                                                    alt={result.username}
                                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                />
                                            ) : (
                                                <UserIcon size={16} color="var(--text-secondary)" />
                                            )}
                                        </div>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ 
                                                fontSize: '0.875rem', 
                                                fontWeight: 600, 
                                                color: 'var(--text-primary)',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '4px'
                                            }}>
                                                {result.username}
                                                {result.is_private && (
                                                    <Lock size={12} color="var(--text-secondary)" />
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {searchQuery.length > 0 && searchResults.length === 0 && (
                            <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                                No users found
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Profile Dialog */}
            <ProfileDialog
                isOpen={isProfileOpen}
                onClose={() => setIsProfileOpen(false)}
                onLogout={handleLogout}
            />
        </div>
    );
};
