package dto

// ==================== Autocomplete DTOs ====================

// AutocompleteSuggestionMeta contains additional metadata for a suggestion
// @Description Additional metadata for autocomplete suggestion (profile pic, verified status, etc.)
type AutocompleteSuggestionMeta struct {
	ProfilePic     *string `json:"profilePic,omitempty" example:"https://storage.blob.core.windows.net/pics/1/abc.jpg"`
	IsVerified     bool    `json:"isVerified" example:"false"`
	FollowersCount int64   `json:"followersCount" example:"150"`
}

// AutocompleteSuggestion represents a single autocomplete suggestion
// @Description A single autocomplete suggestion with text, kind, score, and metadata
type AutocompleteSuggestion struct {
	Text  string                     `json:"text" example:"john_doe"`
	Kind  string                     `json:"kind" example:"user"`
	Score float64                    `json:"score" example:"85.5"`
	Meta  AutocompleteSuggestionMeta `json:"meta"`
}

// AutocompleteResponse represents the autocomplete API response
// @Description Autocomplete response with query echo, request ID for tracing, and ranked suggestions
type AutocompleteResponse struct {
	Query       string                   `json:"query" example:"john"`
	RequestID   string                   `json:"requestId" example:"550e8400-e29b-41d4-a716-446655440000"`
	Suggestions []AutocompleteSuggestion `json:"suggestions"`
}
