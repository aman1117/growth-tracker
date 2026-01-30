/**
 * Autocomplete Component
 *
 * Google-like autocomplete search with keyboard navigation,
 * mobile-first design, and accessibility support.
 */

import { Loader2, Search, X } from 'lucide-react';
import React, {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { useDebounce } from '../../../hooks/useDebounce';
import type { AutocompleteSuggestion } from '../../../types';
import { Avatar } from '../Avatar';
import { VerifiedBadge } from '../VerifiedBadge';
import styles from './Autocomplete.module.css';

export interface AutocompleteProps {
  /** Placeholder text for the input */
  placeholder?: string;
  /** Callback when a suggestion is selected */
  onSelect: (suggestion: AutocompleteSuggestion) => void;
  /** Function to fetch suggestions */
  fetchSuggestions: (query: string, signal: AbortSignal) => Promise<AutocompleteSuggestion[]>;
  /** Minimum characters before searching (default: 1) */
  minChars?: number;
  /** Debounce delay in ms (default: 150) */
  debounceMs?: number;
  /** Auto focus on mount */
  autoFocus?: boolean;
  /** Custom class name */
  className?: string;
  /** Callback when input loses focus (after blur delay) */
  onBlur?: () => void;
}

/**
 * Highlights the matched portion of text
 */
const HighlightedText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  if (!query) return <>{text}</>;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);

  if (index === -1) return <>{text}</>;

  return (
    <>
      {text.slice(0, index)}
      <strong className={styles.highlight}>{text.slice(index, index + query.length)}</strong>
      {text.slice(index + query.length)}
    </>
  );
};

/**
 * Format follower count for display
 */
const formatFollowers = (count: number): string => {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
};

export const Autocomplete: React.FC<AutocompleteProps> = ({
  placeholder = 'Search...',
  onSelect,
  fetchSuggestions,
  minChars = 1,
  debounceMs = 150,
  autoFocus = false,
  className = '',
  onBlur,
}) => {
  // Generate unique IDs for accessibility
  const instanceId = useId();
  const inputId = `autocomplete-input-${instanceId}`;
  const listboxId = `autocomplete-listbox-${instanceId}`;

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // State
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the latest request to prevent stale responses
  const requestCounterRef = useRef(0);

  // Debounced query value
  const debouncedQuery = useDebounce(inputValue.trim(), debounceMs);

  // Fetch suggestions when debounced query changes
  useEffect(() => {
    const query = debouncedQuery;

    // Clear suggestions if query is too short
    if (query.length < minChars) {
      setSuggestions([]);
      setIsOpen(false);
      setActiveIndex(-1);
      return;
    }

    // Increment request counter to track this request
    const currentRequest = ++requestCounterRef.current;

    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const search = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const results = await fetchSuggestions(query, abortController.signal);

        // Only update if this is still the latest request
        if (currentRequest === requestCounterRef.current) {
          setSuggestions(results);
          setIsOpen(results.length > 0);
          setActiveIndex(-1);
        }
      } catch (err) {
        // Ignore abort errors
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }

        // Only update error if this is still the latest request
        if (currentRequest === requestCounterRef.current) {
          setError('Failed to fetch suggestions');
          setSuggestions([]);
          setIsOpen(false);
        }
      } finally {
        if (currentRequest === requestCounterRef.current) {
          setIsLoading(false);
        }
      }
    };

    search();

    // Cleanup: cancel request on unmount or query change
    return () => {
      abortController.abort();
    };
  }, [debouncedQuery, minChars, fetchSuggestions]);

  // Handle suggestion selection
  const handleSelect = useCallback(
    (suggestion: AutocompleteSuggestion) => {
      setInputValue(suggestion.text);
      setSuggestions([]);
      setIsOpen(false);
      setActiveIndex(-1);
      onSelect(suggestion);
    },
    [onSelect]
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (!isOpen || suggestions.length === 0) {
        // Open dropdown on arrow down if there's a query
        if (e.key === 'ArrowDown' && inputValue.trim().length >= minChars) {
          setIsOpen(true);
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
          break;

        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
          break;

        case 'Enter':
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < suggestions.length) {
            handleSelect(suggestions[activeIndex]);
          }
          break;

        case 'Escape':
          e.preventDefault();
          setIsOpen(false);
          setActiveIndex(-1);
          inputRef.current?.blur();
          break;

        case 'Tab':
          // Allow tab to close dropdown naturally
          setIsOpen(false);
          setActiveIndex(-1);
          break;
      }
    },
    [isOpen, suggestions, activeIndex, inputValue, minChars, handleSelect]
  );

  // Handle input focus
  const handleFocus = useCallback(() => {
    // Clear any pending blur timeout
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }

    // Reopen dropdown if there are suggestions
    if (suggestions.length > 0) {
      setIsOpen(true);
    }
  }, [suggestions.length]);

  // Handle input blur with delay for touch/click
  const handleBlur = useCallback(() => {
    // Delay blur to allow click on suggestion to register
    blurTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
      setActiveIndex(-1);
      onBlur?.();
    }, 150);
  }, [onBlur]);

  // Handle suggestion click
  const handleSuggestionClick = useCallback(
    (suggestion: AutocompleteSuggestion, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Clear blur timeout since we're handling the interaction
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }

      handleSelect(suggestion);
    },
    [handleSelect]
  );

  // Handle suggestion hover
  const handleSuggestionHover = useCallback((index: number) => {
    setActiveIndex(index);
  }, []);

  // Handle clear button click
  const handleClear = useCallback(() => {
    setInputValue('');
    setSuggestions([]);
    setIsOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }, []);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const activeItem = listRef.current.children[activeIndex] as HTMLElement;
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [activeIndex]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return (
    <div className={`${styles.container} ${className}`}>
      <div className={styles.inputWrapper}>
        <Search className={styles.searchIcon} size={18} aria-hidden="true" />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          className={styles.input}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck="false"
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
          aria-autocomplete="list"
        />
        {isLoading && (
          <Loader2 className={styles.loadingIcon} size={18} aria-label="Loading..." />
        )}
        {!isLoading && inputValue && (
          <button
            type="button"
            className={styles.clearButton}
            onClick={handleClear}
            aria-label="Clear search"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {isOpen && suggestions.length > 0 && (
        <ul
          ref={listRef}
          id={listboxId}
          className={styles.dropdown}
          role="listbox"
          aria-label="Search suggestions"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={`${suggestion.text}-${index}`}
              id={`${listboxId}-option-${index}`}
              className={`${styles.suggestion} ${index === activeIndex ? styles.active : ''}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(e) => handleSuggestionClick(suggestion, e)}
              onMouseEnter={() => handleSuggestionHover(index)}
            >
              <Avatar
                src={suggestion.meta?.profilePic}
                name={suggestion.text}
                size="sm"
                className={styles.avatar}
              />
              <div className={styles.suggestionInfo}>
                <span className={styles.suggestionText}>
                  <span className={styles.username}>
                    <HighlightedText text={suggestion.text} query={inputValue} />
                  </span>
                  {suggestion.meta?.isVerified && <VerifiedBadge size={12} />}
                </span>
                {suggestion.meta?.followersCount !== undefined && (
                  <span className={styles.followerCount}>
                    {formatFollowers(suggestion.meta.followersCount)} followers
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {isOpen && suggestions.length === 0 && !isLoading && debouncedQuery.length >= minChars && (
        <div className={styles.noResults} role="status">
          No users found
        </div>
      )}

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>
  );
};

export default Autocomplete;
