/**
 * UserSearchAutocomplete Component
 *
 * Pre-configured autocomplete component for searching users with
 * YouTube-like suggestions showing recent searches and trending users on focus.
 */

import { Clock, TrendingUp, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import { searchApi, userApi } from '../../services/api';
import type { AutocompleteSuggestion, SearchSuggestionUser } from '../../types/autocomplete';
import { Autocomplete } from '../ui/Autocomplete';

export interface UserSearchAutocompleteProps {
  /** Callback when a user is selected (in addition to default navigation) */
  onSelect?: (suggestion: AutocompleteSuggestion) => void;
  /** Whether to navigate to user profile on selection (default: true) */
  navigateOnSelect?: boolean;
  /** Callback after navigation/selection completes (for closing modals, etc.) */
  onComplete?: () => void;
  /** Callback when input loses focus without selection (for closing search UI) */
  onBlur?: () => void;
  /** Placeholder text */
  placeholder?: string;
  /** Auto focus the input */
  autoFocus?: boolean;
  /** Custom class name */
  className?: string;
}

/**
 * Convert SearchSuggestionUser to AutocompleteSuggestion format
 */
const toAutocompleteSuggestion = (
  user: SearchSuggestionUser,
  kind: 'recent' | 'trending'
): AutocompleteSuggestion => ({
  text: user.username,
  kind: 'user',
  score: kind === 'recent' ? 100 : 50,
  meta: {
    userId: user.id,
    profilePic: user.profilePic,
    isVerified: user.isVerified,
    followersCount: user.followersCount,
  },
});

/**
 * User search autocomplete with built-in API integration.
 * Shows recent searches and trending users immediately on focus,
 * then switches to autocomplete results when user starts typing.
 *
 * @example
 * ```tsx
 * // Basic usage - navigates to user profile on selection
 * <UserSearchAutocomplete placeholder="Search users..." />
 *
 * // With callback after selection
 * <UserSearchAutocomplete
 *   onComplete={() => setIsSearchOpen(false)}
 *   placeholder="Find users..."
 * />
 * ```
 */
export const UserSearchAutocomplete: React.FC<UserSearchAutocompleteProps> = ({
  onSelect,
  navigateOnSelect = true,
  onComplete,
  onBlur,
  placeholder = 'Search users...',
  autoFocus = false,
  className,
}) => {
  const navigate = useNavigate();
  
  // State for initial suggestions (recent + trending)
  const [initialSuggestions, setInitialSuggestions] = useState<{
    recent: AutocompleteSuggestion[];
    trending: AutocompleteSuggestion[];
  } | null>(null);
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  
  // Track if suggestions have been fetched to avoid duplicate calls
  const suggestionsFetchedRef = useRef(false);
  // Track confirm timeout for cleanup
  const clearConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch suggestions on mount (will show on focus)
  useEffect(() => {
    if (suggestionsFetchedRef.current) return;
    suggestionsFetchedRef.current = true;

    const fetchSuggestions = async () => {
      try {
        const response = await searchApi.getSuggestions();
        setInitialSuggestions({
          recent: response.recent.map((u) => toAutocompleteSuggestion(u, 'recent')),
          trending: response.trending.map((u) => toAutocompleteSuggestion(u, 'trending')),
        });
      } catch (error) {
        console.error('[UserSearchAutocomplete] Failed to fetch suggestions:', error);
        // Set empty suggestions so dropdown shows nothing instead of loading
        setInitialSuggestions({ recent: [], trending: [] });
      } finally {
        setSuggestionsLoaded(true);
      }
    };

    fetchSuggestions();
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (clearConfirmTimeoutRef.current) {
        clearTimeout(clearConfirmTimeoutRef.current);
      }
    };
  }, []);

  const fetchSuggestions = useCallback(
    async (query: string, signal: AbortSignal): Promise<AutocompleteSuggestion[]> => {
      try {
        const response = await userApi.autocomplete(query, 12, signal);
        return response.suggestions || [];
      } catch (error) {
        // Re-throw abort errors so they're handled correctly
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }
        console.error('[UserSearchAutocomplete] Autocomplete failed:', error);
        return [];
      }
    },
    []
  );

  const handleSelect = useCallback(
    (suggestion: AutocompleteSuggestion) => {
      // Call custom handler if provided
      onSelect?.(suggestion);

      // Navigate to user profile if enabled
      if (navigateOnSelect) {
        navigate(APP_ROUTES.USER_PROFILE(suggestion.text));
      }

      // Call completion callback
      onComplete?.();
    },
    [onSelect, navigateOnSelect, navigate, onComplete]
  );

  const handleDeleteRecent = useCallback(
    async (username: string, userId?: number) => {
      // Optimistically remove from UI
      setInitialSuggestions((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          recent: prev.recent.filter((s) => s.text !== username),
        };
      });

      // Delete from server in background
      if (userId) {
        try {
          await searchApi.deleteRecentSearch(userId);
        } catch (error) {
          console.error('[UserSearchAutocomplete] Failed to delete recent search:', error);
          // Revert on error by refetching
          suggestionsFetchedRef.current = false;
          setInitialSuggestions(null);
          setSuggestionsLoaded(false);
        }
      }
    },
    []
  );

  const handleClearAllRecent = useCallback(async () => {
    if (!showClearConfirm) {
      setShowClearConfirm(true);
      // Auto-hide confirm after 3 seconds
      // Clear any existing timeout first
      if (clearConfirmTimeoutRef.current) {
        clearTimeout(clearConfirmTimeoutRef.current);
      }
      clearConfirmTimeoutRef.current = setTimeout(() => {
        setShowClearConfirm(false);
        clearConfirmTimeoutRef.current = null;
      }, 3000);
      return;
    }

    // Clear the timeout since user confirmed
    if (clearConfirmTimeoutRef.current) {
      clearTimeout(clearConfirmTimeoutRef.current);
      clearConfirmTimeoutRef.current = null;
    }

    // Optimistically clear from UI
    setInitialSuggestions((prev) => {
      if (!prev) return prev;
      return { ...prev, recent: [] };
    });
    setShowClearConfirm(false);

    // Clear from server in background
    try {
      await searchApi.clearRecentSearches();
    } catch (error) {
      console.error('[UserSearchAutocomplete] Failed to clear recent searches:', error);
      // Revert on error by refetching
      suggestionsFetchedRef.current = false;
      setInitialSuggestions(null);
      setSuggestionsLoaded(false);
    }
  }, [showClearConfirm]);

  // Render section headers for suggestions
  const renderSectionHeaders = useCallback(
    (_suggestions: AutocompleteSuggestion[], inputValue: string) => {
      // If user is typing, don't show section headers (normal autocomplete mode)
      if (inputValue.trim().length > 0) {
        return null;
      }

      // If no initial suggestions loaded yet or no suggestions, return null
      if (!initialSuggestions || (!initialSuggestions.recent.length && !initialSuggestions.trending.length)) {
        return null;
      }

      return {
        renderBeforeItem: (index: number) => {
          // Recent section header
          if (index === 0 && initialSuggestions.recent.length > 0) {
            return (
              <div className="suggestion-section-header">
                <span className="section-icon"><Clock size={14} /></span>
                <span className="section-title">Recent</span>
                {initialSuggestions.recent.length > 0 && (
                  <button
                    className={`clear-all-btn ${showClearConfirm ? 'confirm-state' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleClearAllRecent();
                    }}
                    type="button"
                  >
                    {showClearConfirm ? 'Confirm' : 'Clear all'}
                  </button>
                )}
              </div>
            );
          }

          // Trending section header
          if (index === initialSuggestions.recent.length && initialSuggestions.trending.length > 0) {
            return (
              <div className="suggestion-section-header">
                <span className="section-icon"><TrendingUp size={14} /></span>
                <span className="section-title">Trending</span>
              </div>
            );
          }

          return null;
        },
        renderAfterItem: (index: number, suggestion: AutocompleteSuggestion) => {
          // Show delete button for recent items
          if (index < initialSuggestions.recent.length) {
            return (
              <button
                className="delete-recent-btn"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleDeleteRecent(suggestion.text, suggestion.meta?.userId);
                }}
                type="button"
                aria-label={`Remove ${suggestion.text} from recent searches`}
              >
                <X size={16} />
              </button>
            );
          }
          return null;
        },
      };
    },
    [initialSuggestions, handleClearAllRecent, handleDeleteRecent, showClearConfirm]
  );

  // Combine recent and trending for initial display
  const combinedInitialSuggestions = suggestionsLoaded && initialSuggestions
    ? [...initialSuggestions.recent, ...initialSuggestions.trending]
    : undefined;

  return (
    <Autocomplete
      placeholder={placeholder}
      onSelect={handleSelect}
      fetchSuggestions={fetchSuggestions}
      minChars={1}
      debounceMs={150}
      autoFocus={autoFocus}
      className={className}
      onBlur={onBlur}
      initialSuggestions={combinedInitialSuggestions}
      renderSectionHelpers={renderSectionHeaders}
    />
  );
};

export default UserSearchAutocomplete;

