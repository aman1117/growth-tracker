//! `AnalyticsService` (port of `internal/services/analytics.go`).

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{Datelike, NaiveDate};
use gt_core::models::Activity;
use gt_core::timeutil;
use gt_users::StreakRepository;

use crate::dates::{add_days, format_date};
use crate::dto::{ActivitySummary, DayActivityBreakdown, DayAnalytics, StreakInfo, WeekAnalyticsResponse};
use crate::gosort::sort_slice;
use crate::repository::ActivityRepository;

const DAY_NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// Weekly analytics.
#[derive(Debug, Clone)]
pub struct AnalyticsService {
    activity_repo: Arc<ActivityRepository>,
    streak_repo: Arc<StreakRepository>,
}

/// Total hours in the database order, summed in `float32` like Go.
fn total_hours(activities: &[Activity]) -> f32 {
    activities.iter().fold(0.0, |sum, a| sum + a.duration_hours)
}

/// `(this - other) / other * 100` in `float32`, `100` when only `this` has hours.
fn percentage(this: f32, other: f32) -> f32 {
    if other > 0.0 {
        ((this - other) / other) * 100.0
    } else if this > 0.0 {
        100.0
    } else {
        0.0
    }
}

/// Monday of the week containing `today`.
fn current_week_start(today: NaiveDate) -> NaiveDate {
    add_days(today, -i64::from(today.weekday().num_days_from_monday()))
}

impl AnalyticsService {
    /// Go `NewAnalyticsService` (whose user repository was unused).
    pub fn new(activity_repo: Arc<ActivityRepository>, streak_repo: Arc<StreakRepository>) -> Self {
        Self { activity_repo, streak_repo }
    }

    /// Analytics of the 7 days starting at `week_start`: totals compared with the previous week
    /// (and, for past weeks, with the current week), a per-day breakdown, a per-activity summary
    /// and streak figures.
    pub async fn get_week_analytics(
        &self,
        user_id: i64,
        week_start: NaiveDate,
    ) -> Result<WeekAnalyticsResponse, sqlx::Error> {
        let week_end = add_days(week_start, 6);
        let prev_week_start = add_days(week_start, -7);
        let prev_week_end = add_days(week_start, -1);
        // Go took the date of `time.Now()`: today in the process time zone.
        let current_start = current_week_start(timeutil::today_local());
        let current_end = add_days(current_start, 6);
        let is_current_week = week_start == current_start;

        let repo = &self.activity_repo;
        let this_week = repo.find_by_user_and_date_range(user_id, week_start, week_end).await?;
        let prev_week = repo.find_by_user_and_date_range(user_id, prev_week_start, prev_week_end).await?;
        let total_current_week = if is_current_week {
            0.0
        } else {
            total_hours(&repo.find_by_user_and_date_range(user_id, current_start, current_end).await?)
        };

        let total_this_week = total_hours(&this_week);
        let total_prev_week = total_hours(&prev_week);
        let percentage_change = percentage(total_this_week, total_prev_week);
        let percentage_vs_current = if is_current_week { 0.0 } else { percentage(total_this_week, total_current_week) };

        Ok(WeekAnalyticsResponse {
            success: true,
            total_hours_this_week: total_this_week,
            total_hours_prev_week: total_prev_week,
            total_hours_current_week: total_current_week,
            percentage_change,
            percentage_vs_current,
            is_current_week,
            streak: self.streak_info(user_id).await,
            daily_breakdown: daily_breakdown(week_start, &this_week),
            activity_summary: activity_summary(&this_week),
        })
    }

    /// Current/longest streak and the dates of the longest run (the latest of equally long
    /// runs). Lookup failures leave the figures empty.
    async fn streak_info(&self, user_id: i64) -> StreakInfo {
        let mut info = StreakInfo::default();
        if let Ok(Some(latest)) = self.streak_repo.find_latest_by_user(user_id).await {
            info.current = latest.current;
            info.longest = latest.longest;
        }
        if let Ok(all) = self.streak_repo.find_all_by_user(user_id).await {
            let mut longest = 0;
            let mut range = None;
            for streak in all.iter().filter(|s| s.current > 0) {
                if streak.current >= longest {
                    longest = streak.current;
                    range = Some((add_days(streak.activity_date, -(streak.current - 1)), streak.activity_date));
                }
            }
            if let Some((start, end)) = range {
                info.longest = longest;
                info.longest_start = format_date(start);
                info.longest_end = format_date(end);
            }
        }
        info
    }
}

/// One entry per day of the week; each day's activities with hours, sorted by hours
/// descending with Go's `sort.Slice` (ties keep Go's order).
fn daily_breakdown(week_start: NaiveDate, activities: &[Activity]) -> Vec<DayAnalytics> {
    let mut by_date: HashMap<String, Vec<&Activity>> = HashMap::new();
    for activity in activities {
        by_date.entry(format_date(activity.activity_date)).or_default().push(activity);
    }
    DAY_NAMES
        .iter()
        .zip(0..)
        .map(|(day_name, offset)| {
            let date = format_date(add_days(week_start, offset));
            let mut day = by_date.remove(&date).unwrap_or_default();
            sort_slice(&mut day, |a, b| a.duration_hours > b.duration_hours);
            let mut total = 0.0;
            let mut breakdown = Vec::new();
            for activity in day.into_iter().filter(|a| a.duration_hours > 0.0) {
                total += activity.duration_hours;
                breakdown.push(DayActivityBreakdown { name: activity.name.clone(), hours: activity.duration_hours });
            }
            DayAnalytics { date, day_name: (*day_name).to_string(), total_hours: total, activities: breakdown }
        })
        .collect()
}

/// Hours per activity over the week (activities with hours only), most hours first. Go built
/// the list from a map, so the order of equal totals was arbitrary.
fn activity_summary(activities: &[Activity]) -> Vec<ActivitySummary> {
    let mut totals: Vec<(String, f32)> = Vec::new();
    for activity in activities {
        match totals.iter_mut().find(|(name, _)| *name == activity.name) {
            Some((_, hours)) => *hours += activity.duration_hours,
            None => totals.push((activity.name.clone(), activity.duration_hours)),
        }
    }
    let mut summary: Vec<ActivitySummary> = totals
        .into_iter()
        .filter(|(_, hours)| *hours > 0.0)
        .map(|(name, total_hours)| ActivitySummary { name, total_hours })
        .collect();
    sort_slice(&mut summary, |a, b| a.total_hours > b.total_hours);
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use gt_core::gojson;

    fn activity(name: &str, hours: f32, date: NaiveDate) -> Activity {
        Activity {
            id: 0,
            user_id: 1,
            name: name.into(),
            duration_hours: hours,
            note: None,
            created_at: gojson::go_zero_time(),
            updated_at: gojson::go_zero_time(),
            activity_date: date,
        }
    }

    #[test]
    fn percentages() {
        assert_eq!(percentage(12.0, 6.0), 100.0);
        assert_eq!(percentage(3.0, 0.0), 100.0);
        assert_eq!(percentage(0.0, 0.0), 0.0);
        assert_eq!(percentage(3.0, 4.0), -25.0);
    }

    #[test]
    fn week_start_is_monday() {
        let d = |m, d| NaiveDate::from_ymd_opt(2026, m, d).unwrap();
        assert_eq!(current_week_start(d(3, 9)), d(3, 9));
        assert_eq!(current_week_start(d(3, 15)), d(3, 9));
        assert_eq!(current_week_start(d(3, 11)), d(3, 9));
    }

    #[test]
    fn breakdown_and_summary() {
        let monday = NaiveDate::from_ymd_opt(2026, 3, 9).unwrap();
        let wednesday = add_days(monday, 2);
        let list = vec![
            activity("workout", 1.0, monday),
            activity("study", 2.0, monday),
            activity("sleep", 8.0, wednesday),
            activity("reels", 0.0, wednesday),
            activity("study", 1.0, add_days(monday, 6)),
        ];
        let days = daily_breakdown(monday, &list);
        assert_eq!(days.len(), 7);
        assert_eq!(days[0].total_hours, 3.0);
        assert_eq!(
            days[0].activities,
            vec![
                DayActivityBreakdown { name: "study".into(), hours: 2.0 },
                DayActivityBreakdown { name: "workout".into(), hours: 1.0 }
            ]
        );
        assert_eq!(days[1].activities, vec![]);
        assert_eq!(days[2].activities.len(), 1, "zero-hour entries are left out");
        assert_eq!(days[6].date, "2026-03-15");
        assert_eq!(days[6].day_name, "Sun");

        let summary = activity_summary(&list);
        let names: Vec<_> = summary.iter().map(|s| (s.name.as_str(), s.total_hours)).collect();
        assert_eq!(names, vec![("sleep", 8.0), ("study", 3.0), ("workout", 1.0)]);
    }
}
