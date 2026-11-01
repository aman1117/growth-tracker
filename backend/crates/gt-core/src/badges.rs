//! Streak badge definitions (port of `internal/constants/badges.go`).

/// A streak badge definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Badge {
    pub key: &'static str,
    pub name: &'static str,
    /// Lucide icon name.
    pub icon: &'static str,
    /// Hex color.
    pub color: &'static str,
    /// Days of streak required.
    pub threshold: i64,
}

/// Badges ordered by threshold (ascending).
pub const BADGES: &[Badge] = &[
    Badge { key: "first_step", name: "First Step", icon: "Footprints", color: "#22c55e", threshold: 1 },
    Badge { key: "spark_starter", name: "Spark Starter", icon: "Zap", color: "#3b82f6", threshold: 7 },
    Badge { key: "flame_keeper", name: "Flame Keeper", icon: "Flame", color: "#f97316", threshold: 15 },
    Badge { key: "iron_will", name: "Iron Will", icon: "Shield", color: "#64748b", threshold: 30 },
    Badge { key: "diamond_mind", name: "Diamond Mind", icon: "Gem", color: "#06b6d4", threshold: 90 },
    Badge { key: "titan", name: "Titan", icon: "Crown", color: "#a855f7", threshold: 120 },
    Badge { key: "legendary", name: "Legendary", icon: "Star", color: "#eab308", threshold: 360 },
];

/// Keys of every badge earned with `longest_streak` (Go returns a nil slice when empty).
pub fn eligible_badge_keys(longest_streak: i64) -> Vec<&'static str> {
    BADGES.iter().filter(|b| longest_streak >= b.threshold).map(|b| b.key).collect()
}

pub fn badge_by_key(key: &str) -> Option<&'static Badge> {
    BADGES.iter().find(|b| b.key == key)
}

pub fn all_badges() -> &'static [Badge] {
    BADGES
}

/// The next badge to earn, or `None` once all are earned.
pub fn next_badge(longest_streak: i64) -> Option<&'static Badge> {
    BADGES.iter().find(|b| longest_streak < b.threshold)
}
