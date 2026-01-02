import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, Search, User as UserIcon, X, Settings2, Lock, ChevronLeft } from 'lucide-react';
import { api } from '../utils/api';
import { ProfileDropdown } from './ProfileDropdown';
import { ThemeToggle } from './ThemeToggle';

interface SearchResult {
    id: number;
    username: string;
    email: string;
    profile_pic?: string;
    is_private: boolean;
}

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user } = useAuth();
    const navigate = useNavigate();

    // Search State
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearchFocused, setIsSearchFocused] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const searchContainerRef = useRef<HTMLDivElement>(null);

    // Focus input when search opens
    useEffect(() => {
        if (isSearchOpen && searchInputRef.current) {
            // Longer delay to ensure animation completes and input is visible
            setTimeout(() => {
                searchInputRef.current?.focus();
                setIsSearchFocused(true);
            }, 350);
        }
    }, [isSearchOpen]);

    // Close search dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
                setIsSearchFocused(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

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
        }, 300);

        return () => clearTimeout(timer);
    }, [searchQuery]);

    const handleUserClick = (username: string) => {
        navigate(`/user/${username}`);
        setIsSearchOpen(false);
        setIsSearchFocused(false);
        setSearchQuery('');
        setSearchResults([]);
    };

    const closeSearch = () => {
        setIsSearchOpen(false);
        setIsSearchFocused(false);
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
                    {!isSearchOpen && (
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
                    )}

                    {user && (
                        <div 
                            ref={searchContainerRef}
                            style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                gap: '0.75rem', 
                                flex: 1, 
                                marginLeft: isSearchOpen ? '0' : '1rem',
                                position: 'relative',
                                justifyContent: 'flex-end',
                                transition: 'margin-left 0.3s ease'
                            }}
                        >
                            {/* Back button - only visible when expanded, positioned far left */}
                            <button
                                onClick={closeSearch}
                                style={{
                                    padding: '0.25rem',
                                    border: 'none',
                                    borderRadius: '50%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: 'transparent',
                                    color: 'var(--text-primary)',
                                    cursor: 'pointer',
                                    flexShrink: 0,
                                    width: isSearchOpen ? '32px' : '0px',
                                    opacity: isSearchOpen ? 1 : 0,
                                    overflow: 'hidden',
                                    transition: 'width 0.3s ease, opacity 0.2s ease',
                                    marginRight: isSearchOpen ? '0.25rem' : '0'
                                }}
                            >
                                <ChevronLeft size={24} />
                            </button>

                            {/* Animated Search Bar */}
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                flex: isSearchOpen ? 1 : 'unset',
                                position: 'relative',
                                justifyContent: 'flex-end'
                            }}>
                                {/* Search Input Container */}
                                <div 
                                    onClick={() => {
                                        if (!isSearchOpen) {
                                            setIsSearchOpen(true);
                                            // Focus immediately on click for mobile keyboard
                                            searchInputRef.current?.focus();
                                        }
                                    }}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: isSearchOpen ? '0.5rem' : '0',
                                        padding: isSearchOpen ? '0.5rem 1rem' : '0',
                                        backgroundColor: 'var(--bg-secondary)',
                                        borderRadius: '9999px',
                                        border: isSearchFocused && isSearchOpen ? '1px solid var(--accent)' : '1px solid transparent',
                                        cursor: isSearchOpen ? 'text' : 'pointer',
                                        flex: isSearchOpen ? 1 : 'unset',
                                        width: isSearchOpen ? 'auto' : '36px',
                                        height: '36px',
                                        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                                        position: 'relative',
                                        overflow: 'hidden'
                                    }}
                                >
                                    <Search 
                                        size={16} 
                                        color="var(--text-secondary)" 
                                        style={{ flexShrink: 0 }}
                                    />
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        placeholder="Search"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        onFocus={() => setIsSearchFocused(true)}
                                        style={{
                                            border: 'none',
                                            background: 'transparent',
                                            outline: 'none',
                                            fontSize: '0.9375rem',
                                            color: 'var(--text-primary)',
                                            flex: isSearchOpen ? 1 : 0,
                                            width: isSearchOpen ? 'auto' : '1px',
                                            minWidth: isSearchOpen ? '0' : '1px',
                                            opacity: isSearchOpen ? 1 : 0,
                                            fontWeight: 400,
                                            padding: 0,
                                            transition: 'flex 0.3s ease, opacity 0.2s ease',
                                            position: isSearchOpen ? 'relative' : 'absolute'
                                        }}
                                    />
                                    {searchQuery.length > 0 && isSearchOpen && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setSearchQuery('');
                                                searchInputRef.current?.focus();
                                            }}
                                            style={{
                                                background: 'none',
                                                border: 'none',
                                                color: 'var(--text-secondary)',
                                                cursor: 'pointer',
                                                padding: '0.125rem',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                flexShrink: 0
                                            }}
                                        >
                                            <X size={16} />
                                        </button>
                                    )}
                                </div>

                                {/* Search Results Dropdown */}
                                {isSearchOpen && isSearchFocused && (searchResults.length > 0 || searchQuery.length > 0) && (
                                    <div style={{
                                        position: 'absolute',
                                        top: 'calc(100% + 8px)',
                                        left: isSearchOpen ? '36px' : '0',
                                        right: 0,
                                        backgroundColor: 'var(--bg-primary)',
                                        borderRadius: '12px',
                                        border: '1px solid var(--border)',
                                        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
                                        overflow: 'hidden',
                                        zIndex: 100,
                                        maxHeight: '320px',
                                        overflowY: 'auto',
                                        animation: 'dropdownFadeIn 0.2s ease-out'
                                    }}>
                                        <style>{`
                                            @keyframes dropdownFadeIn {
                                                from { opacity: 0; transform: translateY(-8px); }
                                                to { opacity: 1; transform: translateY(0); }
                                            }
                                        `}</style>
                                        {searchResults.length > 0 ? (
                                            searchResults.map((result) => (
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
                                                        transition: 'background-color 0.15s'
                                                    }}
                                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                                >
                                                    <div style={{
                                                        width: '40px',
                                                        height: '40px',
                                                        borderRadius: '50%',
                                                        backgroundColor: 'var(--avatar-bg)',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        overflow: 'hidden',
                                                        flexShrink: 0
                                                    }}>
                                                        {result.profile_pic ? (
                                                            <img 
                                                                src={result.profile_pic} 
                                                                alt={result.username}
                                                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                            />
                                                        ) : (
                                                            <UserIcon size={18} color="var(--text-secondary)" />
                                                        )}
                                                    </div>
                                                    <div style={{ flex: 1 }}>
                                                        <div style={{ 
                                                            fontSize: '0.9375rem', 
                                                            fontWeight: 600, 
                                                            color: 'var(--text-primary)',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: '6px'
                                                        }}>
                                                            @{result.username}
                                                            {result.is_private && (
                                                                <Lock size={12} color="var(--text-secondary)" />
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))
                                        ) : searchQuery.length > 0 ? (
                                            <div style={{ 
                                                padding: '2rem 1rem', 
                                                textAlign: 'center', 
                                                color: 'var(--text-secondary)', 
                                                fontSize: '0.875rem' 
                                            }}>
                                                No users found
                                            </div>
                                        ) : null}
                                    </div>
                                )}
                            </div>

                            {/* Edit tiles button - hide when search is open */}
                            {!isSearchOpen && (
                                <button
                                    onClick={() => {
                                        window.dispatchEvent(new CustomEvent('toggleEditMode'));
                                    }}
                                    style={{
                                        padding: 0,
                                        border: 'none',
                                        borderRadius: '50%',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        backgroundColor: 'var(--bg-secondary)',
                                        color: 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        width: '36px',
                                        height: '36px'
                                    }}
                                    title="Customize tiles"
                                >
                                    <Settings2 size={16} />
                                </button>
                            )}

                            <ProfileDropdown />
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
        </div>
    );
};
