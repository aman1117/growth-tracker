// Package constants defines all application-wide constants including badge definitions.
package constants

// Badge represents a streak badge definition
type Badge struct {
	Key       string // Unique identifier
	Name      string // Display name
	Icon      string // Lucide icon name
	Color     string // Hex color
	Threshold int    // Days required to earn
}

// Badge definitions ordered by threshold (ascending)
var Badges = []Badge{
	{Key: "first_step", Name: "First Step", Icon: "Footprints", Color: "#22c55e", Threshold: 1},
	{Key: "spark_starter", Name: "Spark Starter", Icon: "Zap", Color: "#3b82f6", Threshold: 7},
	{Key: "flame_keeper", Name: "Flame Keeper", Icon: "Flame", Color: "#f97316", Threshold: 15},
	{Key: "iron_will", Name: "Iron Will", Icon: "Shield", Color: "#64748b", Threshold: 30},
	{Key: "diamond_mind", Name: "Diamond Mind", Icon: "Gem", Color: "#06b6d4", Threshold: 90},
	{Key: "titan", Name: "Titan", Icon: "Crown", Color: "#a855f7", Threshold: 120},
	{Key: "legendary", Name: "Legendary", Icon: "Star", Color: "#eab308", Threshold: 360},
}

// BadgeMap provides quick lookup by key
var BadgeMap = func() map[string]Badge {
	m := make(map[string]Badge)
	for _, b := range Badges {
		m[b.Key] = b
	}
	return m
}()

// GetEligibleBadgeKeys returns all badge keys the user qualifies for based on their longest streak
func GetEligibleBadgeKeys(longestStreak int) []string {
	var keys []string
	for _, badge := range Badges {
		if longestStreak >= badge.Threshold {
			keys = append(keys, badge.Key)
		}
	}
	return keys
}

// GetBadgeByKey returns a badge by its key, or nil if not found
func GetBadgeByKey(key string) *Badge {
	if badge, ok := BadgeMap[key]; ok {
		return &badge
	}
	return nil
}

// GetAllBadges returns all badge definitions
func GetAllBadges() []Badge {
	return Badges
}

// GetNextBadge returns the next badge to earn based on longest streak, or nil if all earned
func GetNextBadge(longestStreak int) *Badge {
	for _, badge := range Badges {
		if longestStreak < badge.Threshold {
			return &badge
		}
	}
	return nil
}
