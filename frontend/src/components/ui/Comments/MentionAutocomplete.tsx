/**
 * MentionAutocomplete Component
 *
 * Glass dropdown showing user suggestions when typing @.
 * Reuses existing autocomplete API for user search.
 */

import React, { useCallback, useEffect, useState } from 'react';

import { API_ROUTES } from '../../../constants/routes';
import { useDebounce } from '../../../hooks/useDebounce';
import { useEscapeKey } from '../../../hooks/useEscapeKey';
import { apiClient } from '../../../services/api';
import { Avatar } from '../Avatar';
import { VerifiedBadge } from '../VerifiedBadge';
import styles from './CommentInput.module.css';

interface AutocompleteSuggestion {
  text: string;
  kind: string;
  score: number;
  meta: {
    profilePic?: string;
    isVerified?: boolean;
    followersCount?: number;
  };
}

interface AutocompleteApiResponse {
  query: string;
  requestId: string;
  suggestions: AutocompleteSuggestion[];
}

interface MentionAutocompleteProps {
  query: string;
  onSelect: (username: string) => void;
  onClose: () => void;
}

export const MentionAutocomplete: React.FC<MentionAutocompleteProps> = ({
  query,
  onSelect,
  onClose,
}) => {
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    if (!debouncedQuery || debouncedQuery.length < 1) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const fetchSuggestions = async () => {
      try {
        const response = await apiClient.get<AutocompleteApiResponse>(
          `${API_ROUTES.USER.AUTOCOMPLETE}?q=${encodeURIComponent(debouncedQuery)}&limit=5`
        );
        if (!cancelled && response.suggestions) {
          setSuggestions(response.suggestions);
        }
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    };

    fetchSuggestions();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const handleSelect = useCallback(
    (username: string) => {
      onSelect(username);
    },
    [onSelect]
  );

  // Close on Escape (claims the key before the comment sheet while suggestions show)
  useEscapeKey(!!debouncedQuery && suggestions.length > 0, onClose);

  if (!debouncedQuery || suggestions.length === 0) {
    return null;
  }

  return (
    <div className={styles.mentionList} role="group" aria-label="Mention suggestions">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion.text}
          type="button"
          className={styles.mentionOption}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => handleSelect(suggestion.text)}
        >
          <Avatar name={suggestion.text} src={suggestion.meta.profilePic} size="xs" />
          <span className={styles.mentionName}>
            {suggestion.text}
            {suggestion.meta.isVerified && <VerifiedBadge size={14} />}
          </span>
        </button>
      ))}
    </div>
  );
};
