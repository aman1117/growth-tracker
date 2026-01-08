package models

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"regexp"
	"time"
)

// JSONB type for PostgreSQL jsonb column
type JSONB map[string]interface{}

// Value implements the driver.Valuer interface for JSONB
func (j JSONB) Value() (driver.Value, error) {
	if j == nil {
		return nil, nil
	}
	return json.Marshal(j)
}

// Scan implements the sql.Scanner interface for JSONB
func (j *JSONB) Scan(value interface{}) error {
	if value == nil {
		*j = nil
		return nil
	}
	bytes, ok := value.([]byte)
	if !ok {
		return errors.New("type assertion to []byte failed")
	}
	return json.Unmarshal(bytes, j)
}

// CustomTile represents a user-defined custom tile
type CustomTile struct {
	ID    string `json:"id"`    // UUID v4
	Name  string `json:"name"`  // Display name (max 20 chars)
	Icon  string `json:"icon"`  // Lucide icon name
	Color string `json:"color"` // Hex color code
}

// TileConfigData represents the structured tile configuration
type TileConfigData struct {
	Order       []string          `json:"order"`                 // Activity names in display order
	Sizes       map[string]string `json:"sizes"`                 // Activity name -> tile size
	Hidden      []string          `json:"hidden,omitempty"`      // Hidden tile names
	Colors      map[string]string `json:"colors,omitempty"`      // Activity name -> custom color override
	CustomTiles []CustomTile      `json:"customTiles,omitempty"` // User-defined custom tiles
}

// ValidateColor checks if a color is a valid hex color
func ValidateColor(color string) bool {
	if len(color) == 0 {
		return false
	}
	// Match #RGB, #RRGGBB, or #RRGGBBAA formats
	matched, _ := regexp.MatchString(`^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$`, color)
	return matched
}

// ValidateCustomTile validates a custom tile's fields
func (ct *CustomTile) Validate() error {
	if ct.ID == "" {
		return errors.New("custom tile ID is required")
	}

	// Validate UUID format
	uuidRegex := regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	if !uuidRegex.MatchString(ct.ID) {
		return errors.New("custom tile ID must be a valid UUID")
	}

	if ct.Name == "" {
		return errors.New("custom tile name is required")
	}

	if len(ct.Name) > 20 {
		return errors.New("custom tile name cannot exceed 20 characters")
	}

	if ct.Icon == "" {
		return errors.New("custom tile icon is required")
	}

	if !ValidateColor(ct.Color) {
		return errors.New("custom tile color must be a valid hex color")
	}

	return nil
}

// TileConfig represents a user's dashboard tile configuration
type TileConfig struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"uniqueIndex;not null" json:"user_id"`
	Config    JSONB     `gorm:"type:jsonb" json:"config"`
	CreatedAt time.Time `gorm:"not null;default:now();autoCreateTime" json:"created_at"`
	UpdatedAt time.Time `gorm:"not null;default:now();autoUpdateTime" json:"updated_at"`

	// Foreign key relationship
	User User `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE" json:"-"`
}

// TableName specifies the table name for TileConfig
func (TileConfig) TableName() string {
	return "tile_configs"
}

// GetConfigData parses the JSONB config into TileConfigData
func (tc *TileConfig) GetConfigData() (*TileConfigData, error) {
	if tc.Config == nil {
		return &TileConfigData{}, nil
	}

	data, err := json.Marshal(tc.Config)
	if err != nil {
		return nil, err
	}

	var configData TileConfigData
	if err := json.Unmarshal(data, &configData); err != nil {
		return nil, err
	}

	return &configData, nil
}

// SetConfigData converts TileConfigData to JSONB and sets it
func (tc *TileConfig) SetConfigData(data *TileConfigData) error {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return err
	}

	var config JSONB
	if err := json.Unmarshal(jsonData, &config); err != nil {
		return err
	}

	tc.Config = config
	return nil
}
