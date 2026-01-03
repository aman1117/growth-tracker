/**
 * useUserSearch Hook
 * 
 * Handles user search functionality with debouncing and loading states.
 * Extracted from Layout.tsx and AnalyticsPage.tsx to eliminate duplication.
 */

import { useState, useEffect, useCallback } from 'react';
import { useDebounce } from './useDebounce';
import { api } from '../services/api';
import { DEBOUNCE } from '../constants/ui';

export interface SearchResult {
  id: number;
  username: string;
  email: string;
  profile_pic?: string;
  is_private: boolean;
  bio?: string;
}

interface UseUserSearchOptions {
  /** Minimum query length before searching (default: 1) */
  minQueryLength?: number;
  /** Debounce delay in ms (default: 300) */
  debounceDelay?: number;
}

interface UseUserSearchReturn {
  /** Current search query */
  query: string;
  /** Update search query */
  setQuery: (query: string) => void;
  /** Search results */
  results: SearchResult[];
  /** Whether search is in progress */
  isSearching: boolean;
  /** Clear search state */
  clearSearch: () => void;
  /** Error message if search failed */
  error: string | null;
}

/**
 * Hook for searching users with debouncing
 * 
 * @example
 * ```tsx
 * const { query, setQuery, results, isSearching } = useUserSearch();
 * 
 * return (
 *   <input
 *     value={query}
 *     onChange={(e) => setQuery(e.target.value)}
 *     placeholder="Search users..."
 *   />
 *   {isSearching && <Spinner />}
 *   {results.map(user => <UserCard key={user.id} user={user} />)}
 * );
 * ```
 */
export function useUserSearch(
  options: UseUserSearchOptions = {}
): UseUserSearchReturn {
  const { minQueryLength = 1, debounceDelay = DEBOUNCE.SEARCH } = options;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debouncedQuery = useDebounce(query, debounceDelay);

  // Perform search when debounced query changes
  useEffect(() => {
    const searchUsers = async () => {
      const trimmedQuery = debouncedQuery.trim();

      if (trimmedQuery.length < minQueryLength) {
        setResults([]);
        setError(null);
        return;
      }

      setIsSearching(true);
      setError(null);

      try {
        const res = await api.post<{
          success: boolean;
          data: SearchResult[];
          error?: string;
        }>('/users', { username: trimmedQuery });

        if (res.success) {
          setResults(res.data || []);
        } else {
          setResults([]);
          setError(res.error || 'Search failed');
        }
      } catch (err) {
        console.error('Search failed:', err);
        setResults([]);
        setError('Search failed. Please try again.');
      } finally {
        setIsSearching(false);
      }
    };

    searchUsers();
  }, [debouncedQuery, minQueryLength]);

  const clearSearch = useCallback(() => {
    setQuery('');
    setResults([]);
    setError(null);
  }, []);

  return {
    query,
    setQuery,
    results,
    isSearching,
    clearSearch,
    error,
  };
}
