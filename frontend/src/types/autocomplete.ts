/**
 * Autocomplete Types
 *
 * Type definitions for the autocomplete API and components.
 */

/**
 * Metadata for a user autocomplete suggestion
 */
export interface AutocompleteSuggestionMeta {
  /** User ID (for recent searches) */
  userId?: number;
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

/**
 * A user in search suggestions (recent or trending)
 */
export interface SearchSuggestionUser {
  /** User ID */
  id: number;
  /** Username */
  username: string;
  /** Profile picture URL */
  profilePic?: string;
  /** Whether the user is verified */
  isVerified: boolean;
  /** Follower count */
  followersCount: number;
}

/**
 * API response for search suggestions endpoint
 * Returns recent searches and trending users
 */
export interface SearchSuggestionsResponse {
  /** User's recent profile searches */
  recent: SearchSuggestionUser[];
  /** Personalized trending users */
  trending: SearchSuggestionUser[];
}
