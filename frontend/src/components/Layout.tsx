import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { LogOut, TrendingUp, Search, User as UserIcon, X } from 'lucide-react';
import { api } from '../utils/api';

interface SearchResult {
    id: number;
    username: string;
    email: string;
}

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    // Search State
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const handleLogout = () => {
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
                backgroundColor: 'rgba(255, 255, 255, 0.8)', // Semi-transparent
                backdropFilter: 'blur(12px)', // Glassmorphism
                WebkitBackdropFilter: 'blur(12px)',
                position: 'sticky',
                top: 0,
                zIndex: 50
            }}>
                <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 1.5rem' }}>
                    <div
                        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
                        onClick={() => navigate('/')}
                    >
                        <div style={{
                            background: 'var(--text-primary)',
                            color: 'white',
                            padding: '0.25rem',
                            borderRadius: '6px',
                            display: 'flex'
                        }}>
                            <TrendingUp size={20} strokeWidth={2.5} />
                        </div>
                        <h1 style={{
                            fontSize: '1.125rem',
                            fontWeight: 700,
                            color: 'var(--text-primary)',
                            letterSpacing: '-0.025em'
                        }}>
                            Growth Tracker
                        </h1>
                    </div>

                    {user && (
                        <div className="flex items-center gap-4">
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

                            <div className="flex items-center gap-4">
                                <span style={{
                                    fontSize: '1rem',
                                    fontWeight: 700,
                                    color: 'var(--text-primary)'
                                }}>
                                    {user.username}
                                </span>
                                <button
                                    onClick={handleLogout}
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
                                    <LogOut size={16} />
                                </button>
                            </div>
                        </div>
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
                    backgroundColor: 'rgba(0,0,0,0.5)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    zIndex: 100,
                    backdropFilter: 'blur(4px)',
                    paddingTop: '10vh'
                }} onClick={() => setIsSearchOpen(false)}>
                    <div style={{
                        width: '100%',
                        maxWidth: '600px',
                        backgroundColor: 'var(--bg-primary)',
                        borderRadius: '12px',
                        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
                        border: '1px solid var(--border)',
                        overflow: 'hidden',
                        margin: '0 1rem'
                    }} onClick={e => e.stopPropagation()}>
                        <div style={{
                            padding: '1rem',
                            borderBottom: '1px solid var(--border)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem'
                        }}>
                            <Search size={20} color="var(--text-secondary)" />
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
                                    fontSize: '1.125rem',
                                    color: 'var(--text-primary)',
                                    width: '100%',
                                    fontWeight: 500
                                }}
                            />
                            <button
                                onClick={() => setIsSearchOpen(false)}
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

                        {searchResults.length > 0 && (
                            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
                                {searchResults.map((result) => (
                                    <div
                                        key={result.id}
                                        onClick={() => handleUserClick(result.username)}
                                        style={{
                                            padding: '0.75rem 1rem',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            borderBottom: '1px solid var(--border)',
                                            transition: 'background-color 0.2s'
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                    >
                                        <div style={{
                                            width: '40px',
                                            height: '40px',
                                            borderRadius: '50%',
                                            backgroundColor: 'var(--bg-secondary)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center'
                                        }}>
                                            <UserIcon size={20} color="var(--text-secondary)" />
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                                {result.username}
                                            </div>
                                            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                                                {result.email}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {searchQuery.length > 0 && searchResults.length === 0 && (
                            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                                No users found
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
