/**
 * MentionAutocomplete Component
 *
 * Glass dropdown showing user suggestions when typing @.
 * Reuses existing autocomplete API for user search.
 */

import React, { useCallback, useEffect, useState } from 'react';

import { useDebounce } from '../../../hooks/useDebounce';
import { apiClient } from '../../../services/api';
import { API_ROUTES } from '../../../constants/routes';
import { Avatar } from '../Avatar';
import { VerifiedBadge } from '../VerifiedBadge';

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
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  const handleSelect = useCallback(
    (username: string) => {
      onSelect(username);
    },
    [onSelect]
  );

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (!debouncedQuery || suggestions.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        padding: 'var(--space-1) 0',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--glass-border)',
        maxHeight: '200px',
        overflowY: 'auto',
      }}
    >
      {
        suggestions.map((suggestion) => (
          <button
            key={suggestion.text}
            onClick={() => handleSelect(suggestion.text)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              width: '100%',
              padding: 'var(--space-2) var(--space-4)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-primary)',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'var(--glass-hover-bg)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'none';
            }}
          >
            <Avatar name={suggestion.text} src={suggestion.meta.profilePic} size="xs" />
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 'var(--font-medium)' as React.CSSProperties['fontWeight'] }}>
              {suggestion.text}
              {suggestion.meta.isVerified && <VerifiedBadge size={14} />}
            </span>
          </button>
        ))}
    </div>
  );
};
