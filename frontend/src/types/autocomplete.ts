/**
 * Autocomplete Types
 *
 * Type definitions for the autocomplete API and components.
 */

/**
 * Metadata for a user autocomplete suggestion
 */
export interface AutocompleteSuggestionMeta {
  /** User's profile picture URL */
  profilePic?: string;
  /** Whether the user is verified */
  isVerified?: boolean;
  /** User's follower count */
  followersCount?: number;
}

/**
 * A single autocomplete suggestion
 */
export interface AutocompleteSuggestion {
  /** Display text (username) */
  text: string;
  /** Type of suggestion */
  kind: 'user' | 'query' | 'video' | 'entity';
  /** Relevance score (higher = more relevant) */
  score: number;
  /** Additional metadata */
  meta?: AutocompleteSuggestionMeta;
}

/**
 * API response for autocomplete endpoint
 */
export interface AutocompleteResponse {
  /** Echo of the original query */
  query: string;
  /** Unique request ID for tracing */
  requestId: string;
  /** Ranked list of suggestions */
  suggestions: AutocompleteSuggestion[];
}
