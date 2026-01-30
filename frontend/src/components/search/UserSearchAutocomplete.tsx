/**
 * UserSearchAutocomplete Component
 *
 * Pre-configured autocomplete component for searching users.
 * Uses the /api/autocomplete/users endpoint.
 */

import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import { userApi } from '../../services/api';
import type { AutocompleteSuggestion } from '../../types/autocomplete';
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
 * User search autocomplete with built-in API integration.
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
 *
 * // Without navigation (custom handling)
 * <UserSearchAutocomplete
 *   navigateOnSelect={false}
 *   onSelect={(suggestion) => console.log('Selected:', suggestion)}
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
        console.error('Autocomplete failed:', error);
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
    />
  );
};

export default UserSearchAutocomplete;
