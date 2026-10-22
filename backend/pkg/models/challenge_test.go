package models

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestChallenge_DurationDays(t *testing.T) {
	ist := time.FixedZone("IST", 5*3600+1800)
	day := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

	cases := []struct {
		name       string
		start, end time.Time
		want       int
	}{
		{"single day", day(2026, 10, 23), day(2026, 10, 23), 1},
		{"three days", day(2026, 10, 23), day(2026, 10, 25), 3},
		{"across a month", day(2026, 1, 30), day(2026, 2, 2), 4},
		{"across a year", day(2026, 12, 30), day(2027, 1, 2), 4},
		{"leap day", day(2028, 2, 28), day(2028, 3, 1), 3},
		{"sixty days", day(2026, 1, 1), day(2026, 3, 1), 60},
		// Only the calendar fields count, whatever the location or time of day.
		{"times in IST", time.Date(2026, 10, 23, 0, 0, 0, 0, ist), time.Date(2026, 10, 25, 23, 59, 0, 0, ist), 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Challenge{StartDate: tc.start, EndDate: tc.end}
			assert.Equal(t, tc.want, c.DurationDays())
		})
	}
}

func TestActivityName_IsPredefined(t *testing.T) {
	for _, name := range ActivityNames {
		assert.True(t, name.IsPredefined(), "predefined activity %q", name)
	}
	assert.Len(t, ActivityNames, 16, "challenges allow exactly the 16 predefined activities")

	for _, name := range []ActivityName{"", "swimming", "SLEEP", " sleep", "custom:" + validTileUUID} {
		assert.False(t, name.IsPredefined(), "IsPredefined(%q)", name)
	}
	assert.True(t, ActivityName("custom:"+validTileUUID).IsValid(), "custom tiles stay valid activities")
}
