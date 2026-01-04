import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../store';
import { APP_ROUTES } from '../constants/routes';
import { useNavigate } from 'react-router-dom';
import { Search, User as UserIcon, X, Settings2, Lock, ChevronLeft, BarChart3 } from 'lucide-react';
import { api } from '../services/api';
import { ProfileDropdown } from './ProfileDropdown';
import { ThemeToggle } from './ThemeToggle';
import { ProtectedImage } from './ui';

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

    // Close search when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
                // Collapse search entirely when clicking outside
                setIsSearchOpen(false);
                setIsSearchFocused(false);
                setSearchQuery('');
                setSearchResults([]);
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
        navigate(APP_ROUTES.USER_PROFILE(username));
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
                <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 1rem' }}>
                    {!isSearchOpen && (
                        <div
                            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', flexShrink: 0 }}
                            onClick={() => navigate(APP_ROUTES.HOME)}
                        >
                            <img 
                                src="/logo.png" 
                                alt="Growth Tracker" 
                                style={{ 
                                    height: '24px', 
                                    width: 'auto',
                                    filter: 'var(--logo-filter)'
                                }} 
                            />
                        </div>
                    )}

                    {user && (
                        <div 
                            ref={searchContainerRef}
                            style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                gap: '0.5rem', 
                                flex: 1, 
                                marginLeft: isSearchOpen ? '0' : '0.5rem',
                                position: 'relative',
                                justifyContent: 'flex-end',
                                transition: 'margin-left 0.3s ease'
                            }}
                        >
                            {/* Back button - only visible when expanded, positioned far left */}
                            <button
                                onClick={closeSearch}
                                style={{
                                    padding: '0',
                                    border: 'none',
                                    borderRadius: '50%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: 'transparent',
                                    color: 'var(--text-primary)',
                                    cursor: 'pointer',
                                    flexShrink: 0,
                                    width: isSearchOpen ? '20px' : '0px',
                                    opacity: isSearchOpen ? 1 : 0,
                                    overflow: 'hidden',
                                    transition: 'width 0.3s ease, opacity 0.2s ease',
                                    marginRight: '0'
                                }}
                            >
                                <ChevronLeft size={20} />
                            </button>

                            {/* Animated Search Bar */}
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                flex: isSearchOpen ? 1 : 'unset',
                                position: 'relative',
                                justifyContent: isSearchOpen ? 'stretch' : 'flex-end'
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
                                        background: isSearchOpen ? 'var(--bg-secondary)' : 'rgba(255, 255, 255, 0.15)',
                                        backdropFilter: isSearchOpen ? 'none' : 'blur(12px)',
                                        WebkitBackdropFilter: isSearchOpen ? 'none' : 'blur(12px)',
                                        borderRadius: '9999px',
                                        border: isSearchFocused && isSearchOpen ? '1px solid var(--accent)' : '1px solid rgba(255, 255, 255, 0.2)',
                                        cursor: isSearchOpen ? 'text' : 'pointer',
                                        flex: isSearchOpen ? 1 : 'unset',
                                        width: isSearchOpen ? 'auto' : '32px',
                                        height: '32px',
                                        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                                        position: 'relative',
                                        overflow: 'hidden',
                                        boxShadow: isSearchOpen ? 'none' : '0 2px 8px rgba(0, 0, 0, 0.1)'
                                    }}
                                >
                                    <Search 
                                        size={14} 
                                        color="var(--icon-btn-color)" 
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
                                    <div className="search-dropdown" style={{
                                        position: 'absolute',
                                        top: 'calc(100% + 8px)',
                                        left: 0,
                                        right: 0,
                                        background: 'rgba(255, 255, 255, 0.92)',
                                        backdropFilter: 'blur(20px)',
                                        WebkitBackdropFilter: 'blur(20px)',
                                        borderRadius: '20px',
                                        border: '1px solid rgba(0, 0, 0, 0.08)',
                                        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.08)',
                                        overflow: 'hidden',
                                        zIndex: 100,
                                        maxHeight: '280px',
                                        overflowY: 'auto',
                                        animation: 'dropdownFadeIn 0.2s ease-out'
                                    }}>
                                        <style>{`
                                            @keyframes dropdownFadeIn {
                                                from { opacity: 0; transform: translateY(-8px); }
                                                to { opacity: 1; transform: translateY(0); }
                                            }
                                            [data-theme='dark'] .search-dropdown {
                                                background: rgba(30, 30, 30, 0.95) !important;
                                                border-color: rgba(255, 255, 255, 0.1) !important;
                                            }
                                        `}</style>
                                        {searchResults.length > 0 ? (
                                            searchResults.map((result, index) => (
                                                <div
                                                    key={result.id}
                                                    onClick={() => handleUserClick(result.username)}
                                                    style={{
                                                        padding: '0.5rem 0.75rem',
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '0.5rem',
                                                        borderBottom: index < searchResults.length - 1 ? '1px solid var(--tile-glass-border)' : 'none',
                                                        transition: 'background-color 0.15s'
                                                    }}
                                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'}
                                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                                >
                                                    <div style={{
                                                        width: '28px',
                                                        height: '28px',
                                                        borderRadius: '50%',
                                                        backgroundColor: 'var(--avatar-bg)',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        overflow: 'hidden',
                                                        flexShrink: 0
                                                    }}>
                                                        {result.profile_pic ? (
                                                            <ProtectedImage 
                                                                src={result.profile_pic} 
                                                                alt={result.username}
                                                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                            />
                                                        ) : (
                                                            <UserIcon size={14} color="var(--text-secondary)" />
                                                        )}
                                                    </div>
                                                    <span style={{ 
                                                        fontSize: '0.9375rem', 
                                                        fontWeight: 500, 
                                                        color: 'var(--text-primary)',
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap',
                                                        flex: 1
                                                    }}>
                                                        {result.username}
                                                    </span>
                                                </div>
                                            ))
                                        ) : searchQuery.length > 0 ? (
                                            <div style={{ 
                                                padding: '1.25rem 0.75rem', 
                                                textAlign: 'center', 
                                                color: 'var(--text-secondary)', 
                                                fontSize: '0.9375rem' 
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
                                        closeSearch();
                                        window.dispatchEvent(new CustomEvent('toggleEditMode'));
                                    }}
                                    style={{
                                        padding: 0,
                                        border: '1px solid rgba(255, 255, 255, 0.2)',
                                        borderRadius: '50%',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        background: 'rgba(255, 255, 255, 0.15)',
                                        backdropFilter: 'blur(12px)',
                                        WebkitBackdropFilter: 'blur(12px)',
                                        color: 'var(--icon-btn-color)',
                                        cursor: 'pointer',
                                        width: '32px',
                                        height: '32px',
                                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
                                        transition: 'all 0.2s ease'
                                    }}
                                    title="Customize tiles"
                                >
                                    <Settings2 size={14} />
                                </button>
                            )}

                            {/* Analytics button - hide when search is open */}
                            {!isSearchOpen && (
                                <button
                                    onClick={() => {
                                        closeSearch();
                                        navigate(APP_ROUTES.ANALYTICS);
                                    }}
                                    style={{
                                        padding: 0,
                                        border: '1px solid rgba(255, 255, 255, 0.2)',
                                        borderRadius: '50%',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        background: 'rgba(255, 255, 255, 0.15)',
                                        backdropFilter: 'blur(12px)',
                                        WebkitBackdropFilter: 'blur(12px)',
                                        color: 'var(--icon-btn-color)',
                                        cursor: 'pointer',
                                        width: '32px',
                                        height: '32px',
                                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
                                        transition: 'all 0.2s ease'
                                    }}
                                    title="Analytics"
                                >
                                    <BarChart3 size={14} />
                                </button>
                            )}

                            <ProfileDropdown onOpen={closeSearch} />
                        </div>
                    )}
                    
                    {/* Show theme toggle even when not logged in */}
                    {!user && (
                        <ThemeToggle />
                    )}
                </div>
            </header>

            {/* Backdrop blur when search is open */}
            {isSearchOpen && (
                <div 
                    onClick={closeSearch}
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0,0,0,0.4)',
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                        zIndex: 40,
                        animation: 'fadeIn 0.2s ease-out'
                    }}
                />
            )}
            <style>{`
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
            `}</style>

            <main style={{ flex: 1, paddingTop: '0.5rem' }}>
                {children}
            </main>
        </div>
    );
};
