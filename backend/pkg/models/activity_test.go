package models

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

const validTileUUID = "3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"

func TestActivityName_IsValid(t *testing.T) {
	for _, name := range ActivityNames {
		assert.True(t, name.IsValid(), "predefined activity %q", name)
	}

	cases := []struct {
		name ActivityName
		want bool
	}{
		{"", false},
		{"swimming", false},
		{"SLEEP", false},
		{" sleep", false},
		{"custom:" + validTileUUID, true},
		{"custom:" + ActivityName(strings.ToUpper(validTileUUID)), true},
		{"custom:", false},
		{"custom", false},
		{"Custom:" + validTileUUID, false},
		{ActivityName("custom:" + validTileUUID[:35]), false},
		{"custom:" + validTileUUID + "0", false},
		{"custom:3f2b8c4e1a2b-4c3d-8e9f-0a1b2c3d4e5f0", false},     // hyphen missing at position 8
		{"custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5g", false},     // non-hex digit
		{"custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d-e5f", false},     // hyphen in a hex position
		{"custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e\u00e9", false}, // 36 bytes ending in a multi-byte rune
	}
	for _, tc := range cases {
		assert.Equal(t, tc.want, tc.name.IsValid(), "IsValid(%q)", tc.name)
	}
}

func TestActivityName_CustomTileHelpers(t *testing.T) {
	custom := ActivityName("custom:" + validTileUUID)

	assert.True(t, custom.IsCustomTile())
	assert.True(t, custom.ValidateCustomTileFormat())
	assert.Equal(t, validTileUUID, custom.GetCustomTileID())

	for _, name := range []ActivityName{ActivitySleep, "custom:", "customer"} {
		assert.False(t, name.IsCustomTile(), "IsCustomTile(%q)", name)
		assert.False(t, name.ValidateCustomTileFormat(), "ValidateCustomTileFormat(%q)", name)
		assert.Empty(t, name.GetCustomTileID(), "GetCustomTileID(%q)", name)
	}

	malformed := ActivityName("custom:not-a-uuid")
	assert.True(t, malformed.IsCustomTile(), "the prefix alone makes it a custom tile")
	assert.False(t, malformed.ValidateCustomTileFormat())
	assert.Equal(t, "not-a-uuid", malformed.GetCustomTileID())
}

func TestActivity_Validate(t *testing.T) {
	cases := []struct {
		name     string
		activity Activity
		wantErr  string
	}{
		{"zero hours", Activity{Name: ActivitySleep, DurationHours: 0}, ""},
		{"full day", Activity{Name: ActivityStudy, DurationHours: 24}, ""},
		{"quarter hour", Activity{Name: ActivityWorkout, DurationHours: 0.25}, ""},
		{"custom tile", Activity{Name: ActivityName("custom:" + validTileUUID), DurationHours: 1.5}, ""},
		{"negative hours", Activity{Name: ActivitySleep, DurationHours: -0.25}, "duration_hours must be between 0 and 24"},
		{"more than a day", Activity{Name: ActivitySleep, DurationHours: 24.25}, "duration_hours must be between 0 and 24"},
		{"unknown name", Activity{Name: "swimming", DurationHours: 1}, "invalid activity name: swimming"},
		{"malformed custom tile", Activity{Name: "custom:123", DurationHours: 1}, "invalid activity name: custom:123"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.activity.Validate()
			hookErr := tc.activity.BeforeSave(nil)
			if tc.wantErr == "" {
				assert.NoError(t, err)
				assert.NoError(t, hookErr, "BeforeSave validates")
				return
			}
			assert.EqualError(t, err, tc.wantErr)
			assert.EqualError(t, hookErr, tc.wantErr, "BeforeSave validates")
		})
	}
}
