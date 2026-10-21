package models

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidateColor(t *testing.T) {
	valid := []string{"#fff", "#FFF", "#a1B2c3", "#A1B2C380", "#000000"}
	for _, c := range valid {
		assert.True(t, ValidateColor(c), "ValidateColor(%q)", c)
	}
	invalid := []string{"", "fff", "#ff", "#ffff", "#fffff", "#fffffff", "#fffffffff", "#ggg", "red", " #fff", "#fff "}
	for _, c := range invalid {
		assert.False(t, ValidateColor(c), "ValidateColor(%q)", c)
	}
}

func TestCustomTile_Validate(t *testing.T) {
	valid := CustomTile{ID: validTileUUID, Name: "Meditation", Icon: "flower", Color: "#A1B2C3"}

	cases := []struct {
		name    string
		mutate  func(*CustomTile)
		wantErr string
	}{
		{"valid", func(*CustomTile) {}, ""},
		{"upper-case UUID", func(ct *CustomTile) { ct.ID = strings.ToUpper(validTileUUID) }, ""},
		{"20-character name", func(ct *CustomTile) { ct.Name = strings.Repeat("a", 20) }, ""},
		{"short color", func(ct *CustomTile) { ct.Color = "#abc" }, ""},
		{"missing ID", func(ct *CustomTile) { ct.ID = "" }, "custom tile ID is required"},
		{"malformed ID", func(ct *CustomTile) { ct.ID = "custom-1" }, "custom tile ID must be a valid UUID"},
		{"ID with prefix", func(ct *CustomTile) { ct.ID = "custom:" + validTileUUID }, "custom tile ID must be a valid UUID"},
		{"missing name", func(ct *CustomTile) { ct.Name = "" }, "custom tile name is required"},
		{"21-character name", func(ct *CustomTile) { ct.Name = strings.Repeat("a", 21) }, "custom tile name cannot exceed 20 characters"},
		{"missing icon", func(ct *CustomTile) { ct.Icon = "" }, "custom tile icon is required"},
		{"missing color", func(ct *CustomTile) { ct.Color = "" }, "custom tile color must be a valid hex color"},
		{"named color", func(ct *CustomTile) { ct.Color = "teal" }, "custom tile color must be a valid hex color"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tile := valid
			tc.mutate(&tile)
			err := tile.Validate()
			if tc.wantErr == "" {
				assert.NoError(t, err)
				return
			}
			assert.EqualError(t, err, tc.wantErr)
		})
	}
}

func TestCustomTile_Validate_NameLimitCountsCharactersNotBytes(t *testing.T) {
	cases := map[string]string{
		"Hindi, 10 characters in 28 bytes": "योग अभ्यास",
		"20 accented characters":           strings.Repeat("é", 20),
		"20 emoji":                         strings.Repeat("💪", 20),
	}
	for name, tileName := range cases {
		t.Run(name, func(t *testing.T) {
			tile := CustomTile{ID: validTileUUID, Name: tileName, Icon: "flower", Color: "#ff8800"}
			assert.NoError(t, tile.Validate())
		})
	}

	t.Run("21 accented characters", func(t *testing.T) {
		tile := CustomTile{ID: validTileUUID, Name: strings.Repeat("é", 21), Icon: "flower", Color: "#ff8800"}
		assert.EqualError(t, tile.Validate(), "custom tile name cannot exceed 20 characters")
	})
}

func TestTileConfig_GetConfigData(t *testing.T) {
	t.Run("no config yet", func(t *testing.T) {
		data, err := (&TileConfig{}).GetConfigData()
		require.NoError(t, err)
		assert.Equal(t, &TileConfigData{}, data)
	})

	t.Run("config loaded from jsonb", func(t *testing.T) {
		var config JSONB
		require.NoError(t, config.Scan([]byte(`{
			"order": ["sleep", "custom:`+validTileUUID+`"],
			"sizes": {"sleep": "large"},
			"hidden": ["reels"],
			"colors": {"sleep": "#112233"},
			"customTiles": [{"id": "`+validTileUUID+`", "name": "Yoga", "icon": "flower", "color": "#00ff00"}]
		}`)))

		data, err := (&TileConfig{Config: config}).GetConfigData()

		require.NoError(t, err)
		assert.Equal(t, &TileConfigData{
			Order:       []string{"sleep", "custom:" + validTileUUID},
			Sizes:       map[string]string{"sleep": "large"},
			Hidden:      []string{"reels"},
			Colors:      map[string]string{"sleep": "#112233"},
			CustomTiles: []CustomTile{{ID: validTileUUID, Name: "Yoga", Icon: "flower", Color: "#00ff00"}},
		}, data)
	})

	t.Run("wrongly shaped config", func(t *testing.T) {
		_, err := (&TileConfig{Config: JSONB{"order": "sleep"}}).GetConfigData()
		assert.Error(t, err)
	})

	t.Run("config that cannot be encoded", func(t *testing.T) {
		_, err := (&TileConfig{Config: JSONB{"order": make(chan int)}}).GetConfigData()
		assert.Error(t, err)
	})
}

func TestTileConfig_SetConfigData(t *testing.T) {
	in := &TileConfigData{
		Order:       []string{"study", "sleep"},
		Sizes:       map[string]string{"study": "small"},
		CustomTiles: []CustomTile{{ID: validTileUUID, Name: "Yoga", Icon: "flower", Color: "#00ff00"}},
	}
	tc := &TileConfig{Config: JSONB{"stale": true}}

	require.NoError(t, tc.SetConfigData(in))

	assert.NotContains(t, tc.Config, "stale", "the whole config is replaced")
	assert.NotContains(t, tc.Config, "hidden", "empty optional fields are omitted")
	assert.Equal(t, []interface{}{"study", "sleep"}, tc.Config["order"])
	assert.Contains(t, tc.Config, "customTiles")

	out, err := tc.GetConfigData()
	require.NoError(t, err)
	assert.Equal(t, in, out, "round trip")
}
