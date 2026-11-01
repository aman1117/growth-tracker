//! The development fixtures of `cmd/seed/main.go`: ten users, their activity history patterns
//! and the follow graph.

use chrono::{Duration, NaiveDate};

/// Password of every seeded user.
pub const SEED_PASSWORD: &str = "password123";

/// A seeded account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeedUser {
    pub email: &'static str,
    pub username: &'static str,
    pub bio: &'static str,
    pub is_private: bool,
    pub is_verified: bool,
}

const fn user(
    email: &'static str,
    username: &'static str,
    bio: &'static str,
    is_private: bool,
    is_verified: bool,
) -> SeedUser {
    SeedUser { email, username, bio, is_private, is_verified }
}

/// The seeded accounts, in creation order (ids follow this order).
pub const SEED_USERS: [SeedUser; 10] = [
    user("alice@local.dev", "alice", "📚 Student | 💪 Fitness enthusiast | Building better habits daily", false, true),
    user("bob@local.dev", "bob", "Software developer 🖥️ | Coffee addict ☕", false, false),
    user("charlie@local.dev", "charlie", "Private account 🔒", true, false),
    user("diana@local.dev", "diana", "🎨 Designer | 🧘 Yoga lover | Tracking my growth journey", false, true),
    user("evan@local.dev", "evan", "Entrepreneur 🚀 | Early bird 🌅 | 100 day streak goal", false, false),
    user("fiona@local.dev", "fiona", "Medical student 🏥 | Marathon runner 🏃‍♀️", false, false),
    user("george@local.dev", "george", "📖 Bookworm | 🎮 Gamer | Habit tracking newbie", true, false),
    user("hannah@local.dev", "hannah", "Music teacher 🎵 | Piano & Guitar | Daily practice tracker", false, false),
    user("ivan@local.dev", "ivan", "🏋️ Personal trainer | Helping others reach their goals", false, true),
    user("julia@local.dev", "julia", "Data scientist 📊 | ML enthusiast | Continuous learner", false, false),
];

/// Active follows: follower -> followees.
pub const FOLLOWS: &[(&str, &[&str])] = &[
    ("alice", &["bob", "diana", "evan", "fiona", "hannah", "ivan", "julia"]),
    ("bob", &["alice", "charlie", "diana", "evan"]),
    ("charlie", &["alice", "bob"]),
    ("diana", &["alice", "bob", "evan", "fiona", "ivan"]),
    ("evan", &["alice", "diana", "fiona", "hannah"]),
    ("fiona", &["alice", "bob", "diana", "evan", "hannah", "ivan", "julia"]),
    ("george", &["alice", "diana"]),
    ("hannah", &["alice", "bob", "diana", "evan", "fiona"]),
    ("ivan", &["alice", "diana", "evan", "fiona"]),
    ("julia", &["alice", "bob", "diana", "fiona", "ivan"]),
];

/// Pending follow requests to private accounts: follower -> followees.
pub const PENDING_REQUESTS: &[(&str, &[&str])] = &[
    ("alice", &["charlie", "george"]),
    ("bob", &["george"]),
    ("diana", &["charlie", "george"]),
    ("evan", &["charlie"]),
];

/// How much history a user gets: every day from `days_to_seed` days ago through today, except
/// the `skip_days` offsets (a broken streak).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreakPattern {
    pub days_to_seed: i64,
    pub skip_days: &'static [i64],
}

impl StreakPattern {
    /// The per-user pattern (unknown users get 10 days).
    pub fn for_user(username: &str) -> Self {
        let (days_to_seed, skip_days): (i64, &'static [i64]) = match username {
            "alice" => (15, &[]),
            // Broke the streak 5 days ago
            "bob" => (50, &[1, 2, 3, 4, 5]),
            "charlie" => (7, &[]),
            "diana" => (30, &[]),
            "evan" => (20, &[]),
            // Broke the streak 2 days ago
            "fiona" => (65, &[1, 2]),
            "george" => (5, &[]),
            "hannah" => (12, &[]),
            "ivan" => (25, &[]),
            "julia" => (8, &[]),
            _ => (10, &[]),
        };
        Self { days_to_seed, skip_days }
    }

    /// The day count the Go seeder logged (`daysToSeed - len(skipDays)`; today is one more).
    pub fn logged_days(&self) -> i64 {
        self.days_to_seed - self.skip_days.len() as i64
    }
}

/// One seeded day: its streak record values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeedDay {
    pub date: NaiveDate,
    pub current: i64,
    pub longest: i64,
}

/// A user's seeded days (oldest first) and the final streak values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreakHistory {
    pub days: Vec<SeedDay>,
    pub current: i64,
    pub longest: i64,
}

impl StreakHistory {
    /// Walks the pattern from the oldest day to `today`: a skipped day resets the current
    /// streak, a day following the previous logged day extends it, any other day restarts it.
    pub fn build(today: NaiveDate, pattern: &StreakPattern) -> Self {
        let mut days = Vec::new();
        let (mut current, mut longest) = (0_i64, 0_i64);
        let mut last: Option<NaiveDate> = None;
        for offset in (0..=pattern.days_to_seed).rev() {
            if pattern.skip_days.contains(&offset) {
                current = 0;
                continue;
            }
            let date = today - Duration::days(offset);
            current = match last {
                Some(previous) if (date - previous).num_days() > 1 => 1,
                _ => current + 1,
            };
            longest = longest.max(current);
            days.push(SeedDay { date, current, longest });
            last = Some(date);
        }
        Self { days, current, longest }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 3, 10).unwrap()
    }

    #[test]
    fn unbroken_history_ends_today() {
        let history = StreakHistory::build(today(), &StreakPattern::for_user("alice"));
        assert_eq!(history.days.len(), 16, "15 days ago through today");
        assert_eq!(
            history.days[0],
            SeedDay { date: NaiveDate::from_ymd_opt(2026, 2, 23).unwrap(), current: 1, longest: 1 }
        );
        assert_eq!(history.days[15], SeedDay { date: today(), current: 16, longest: 16 });
        assert_eq!((history.current, history.longest), (16, 16));
        assert_eq!(StreakPattern::for_user("alice").logged_days(), 15);
    }

    #[test]
    fn a_gap_restarts_the_streak() {
        let history = StreakHistory::build(today(), &StreakPattern::for_user("bob"));
        assert_eq!(history.days.len(), 46);
        let last_before_gap = history.days[44];
        assert_eq!(last_before_gap.date, today() - Duration::days(6));
        assert_eq!((last_before_gap.current, last_before_gap.longest), (45, 45));
        assert_eq!(history.days[45], SeedDay { date: today(), current: 1, longest: 45 });
        assert_eq!(StreakPattern::for_user("bob").logged_days(), 45);

        let fiona = StreakHistory::build(today(), &StreakPattern::for_user("fiona"));
        assert_eq!((fiona.current, fiona.longest), (1, 63));
    }
}
