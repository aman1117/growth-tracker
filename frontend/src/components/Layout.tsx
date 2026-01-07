import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../store';
import { APP_ROUTES } from '../constants/routes';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, User as UserIcon, X, ChevronLeft } from 'lucide-react';
import { api } from '../services/api';
import { ThemeToggle } from './ThemeToggle';
import { ProtectedImage, VerifiedBadge, NotificationCenter } from './ui';
import { BottomNavigation } from './BottomNavigation';
import type { Notification, LikeMetadata } from '../types';

interface SearchResult {
    id: number;
    username: string;
    email: string;
    profile_pic?: string;
    is_private: boolean;
    is_verified?: boolean;
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

    // Type guard to check if metadata is LikeMetadata
    const isLikeMetadata = (metadata: unknown): metadata is LikeMetadata => {
        return (
            metadata !== null &&
            typeof metadata === 'object' &&
            'liker_username' in metadata &&
            'liked_date' in metadata
        );
    };

    // Handle notification card click - navigate to liked date for like notifications
    const handleNotificationClick = useCallback(
        (notification: Notification) => {
            if (notification.type === 'like_received' && isLikeMetadata(notification.metadata)) {
                // Navigate to home with the liked date as a query parameter
                navigate(`${APP_ROUTES.HOME}?date=${notification.metadata.liked_date}`);
            }
        },
        [navigate]
    );

    // Handle username click - navigate to user profile
    const handleUsernameClick = useCallback(
        (username: string) => {
            navigate(APP_ROUTES.USER_PROFILE(username));
        },
        [navigate]
    );

    const location = useLocation();
    const isSettingsPage = location.pathname === APP_ROUTES.SETTINGS;

    return (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
            <header style={{
                borderBottom: '1px solid var(--border)',
                padding: '0.75rem 0',
                backgroundColor: 'var(--header-bg)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                position: 'sticky',
                top: 0,
                zIndex: 50,
                transition: 'background-color 0.3s ease, border-color 0.3s ease'
            }}>
                <div className="container" style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    padding: '0 1rem',
                    maxWidth: '560px',
                    margin: '0 auto'
                }}>
                    {/* Logo - Left side */}
                    {!isSearchOpen && (
                        <div
                            style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                gap: '0.5rem', 
                                cursor: 'pointer', 
                                flexShrink: 0 
                            }}
                            onClick={() => navigate(APP_ROUTES.HOME)}
                        >
                            <img 
                                src="/logo.png" 
                                alt="Growth Tracker" 
                                style={{ 
                                    height: '28px', 
                                    width: 'auto',
                                    filter: 'var(--logo-filter)'
                                }} 
                            />
                        </div>
                    )}

                    {/* Right side icons */}
                    {user && (
                        <div 
                            ref={searchContainerRef}
                            style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                gap: '0.75rem', 
                                flex: isSearchOpen ? 1 : 'unset',
                                marginLeft: isSearchOpen ? '0' : 'auto',
                                position: 'relative',
                                justifyContent: 'flex-end',
                                transition: 'margin-left 0.3s ease'
                            }}
                        >
                            {/* Back button - only visible when search expanded */}
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
                                    width: isSearchOpen ? '24px' : '0px',
                                    opacity: isSearchOpen ? 1 : 0,
                                    overflow: 'hidden',
                                    transition: 'width 0.3s ease, opacity 0.2s ease',
                                    marginRight: '0'
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
                                justifyContent: isSearchOpen ? 'stretch' : 'flex-end'
                            }}>
                                {/* Search Input Container */}
                                <div 
                                    onClick={() => {
                                        if (!isSearchOpen) {
                                            setIsSearchOpen(true);
                                            searchInputRef.current?.focus();
                                        }
                                    }}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: isSearchOpen ? '0.5rem' : '0',
                                        padding: isSearchOpen ? '0.625rem 1rem' : '0',
                                        background: isSearchOpen ? 'var(--bg-secondary)' : 'transparent',
                                        borderRadius: '9999px',
                                        border: isSearchFocused && isSearchOpen ? '1px solid var(--accent)' : isSearchOpen ? '1px solid var(--border)' : 'none',
                                        cursor: isSearchOpen ? 'text' : 'pointer',
                                        flex: isSearchOpen ? 1 : 'unset',
                                        width: isSearchOpen ? 'auto' : '40px',
                                        height: '40px',
                                        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                                        position: 'relative',
                                        overflow: 'hidden'
                                    }}
                                >
                                    <Search 
                                        size={22} 
                                        color="var(--text-primary)" 
                                        strokeWidth={1.8}
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
                                            fontSize: '16px',
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
                                                background: 'var(--bg-tertiary)',
                                                border: 'none',
                                                borderRadius: '50%',
                                                color: 'var(--text-secondary)',
                                                cursor: 'pointer',
                                                padding: '0.25rem',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                flexShrink: 0
                                            }}
                                        >
                                            <X size={14} />
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
                                        background: 'var(--glass-bg)',
                                        backdropFilter: 'blur(20px)',
                                        WebkitBackdropFilter: 'blur(20px)',
                                        borderRadius: '16px',
                                        border: '1px solid var(--glass-border)',
                                        boxShadow: 'var(--glass-shadow)',
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
                                                        borderBottom: index < searchResults.length - 1 ? '1px solid var(--border)' : 'none',
                                                        transition: 'background-color 0.15s'
                                                    }}
                                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                                >
                                                    <div style={{
                                                        width: '32px',
                                                        height: '32px',
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
                                                            <UserIcon size={16} color="var(--text-secondary)" />
                                                        )}
                                                    </div>
                                                    <span style={{ 
                                                        fontSize: '0.875rem', 
                                                        fontWeight: 500, 
                                                        color: 'var(--text-primary)',
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap',
                                                        flex: 1,
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '0.25rem'
                                                    }}>
                                                        {result.username}
                                                        {result.is_verified && <VerifiedBadge size={12} />}
                                                    </span>
                                                </div>
                                            ))
                                        ) : searchQuery.length > 0 ? (
                                            <div style={{ 
                                                padding: '1.25rem 0.75rem', 
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

                            {/* Notifications - hide when search is open */}
                            {!isSearchOpen && (
                                <NotificationCenter
                                    onNotificationClick={handleNotificationClick}
                                    onUsernameClick={handleUsernameClick}
                                />
                            )}
                        </div>
                    )}
                    
                    {/* Show theme toggle when not logged in */}
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

            <main style={{ 
                flex: 1, 
                paddingTop: '0.5rem', 
                paddingBottom: user && !isSettingsPage ? '80px' : '0.5rem' 
            }}>
                {children}
            </main>

            {/* Bottom Navigation - only show for logged in users and not on settings page */}
            {user && !isSettingsPage && <BottomNavigation />}
        </div>
    );
};
