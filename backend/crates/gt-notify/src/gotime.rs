//! Go `time` arithmetic that depends on the process time zone (`time.Local`).

use chrono::{DateTime, Local, LocalResult, TimeZone, Utc};
use gt_core::gojson::go_zero_time;

/// Go `t.AddDate(0, 0, days)` for a local-zone `t`: the same local wall-clock time `days`
/// calendar days later (earlier when negative). This equals `t + days * 24h` unless a DST change
/// lies in between. Out-of-range results saturate at Go's zero time.
pub(crate) fn add_days_local(t: DateTime<Utc>, days: i64) -> DateTime<Utc> {
    let local = t.with_timezone(&Local);
    let Some(naive) = chrono::Duration::try_days(days)
        .and_then(|d| local.date_naive().checked_add_signed(d))
        .map(|date| date.and_time(local.time()))
    else {
        return go_zero_time();
    };
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(t) => t.with_timezone(&Utc),
        LocalResult::Ambiguous(earlier, _) => earlier.with_timezone(&Utc),
        // A wall time skipped by a DST change: keep the original offset.
        LocalResult::None => (naive - *local.offset()).and_utc(),
    }
}

/// Go `time.Now().AddDate(0, 0, -days)`.
pub(crate) fn local_days_ago(days: i64) -> DateTime<Utc> {
    days.checked_neg().map_or_else(go_zero_time, |d| add_days_local(Utc::now(), d))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};

    #[test]
    fn adds_calendar_days_in_the_local_zone() {
        let t = Utc.with_ymd_and_hms(2026, 3, 30, 1, 30, 15).unwrap();
        let earlier = add_days_local(t, -30);
        let (before, after) = (t.with_timezone(&Local), earlier.with_timezone(&Local));
        assert_eq!(before.date_naive() - after.date_naive(), chrono::Duration::days(30));
        assert_eq!((after.hour(), after.minute(), after.second()), (before.hour(), before.minute(), before.second()));
        assert_eq!(add_days_local(t, 0), t);
        assert_eq!(add_days_local(t, -i64::MAX), go_zero_time());
        assert!(local_days_ago(1) < Utc::now());
        assert_eq!(local_days_ago(i64::MIN), go_zero_time());
        assert_eq!(add_days_local(t, 365).year(), 2027);
    }
}
