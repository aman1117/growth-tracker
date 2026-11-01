//! Calendar-date helpers reproducing Go's `time.Time.Format("2006-01-02")` and `AddDate`.

use chrono::{Datelike, Duration, NaiveDate};

/// `YYYY-MM-DD` like Go's `Format("2006-01-02")`: the year is zero-padded to four digits and
/// never gets a `+` sign (chrono's `%Y` writes `+10000`).
pub fn format_date(date: NaiveDate) -> String {
    let year = date.year();
    let year = if year < 0 { format!("-{:04}", -i64::from(year)) } else { format!("{year:04}") };
    format!("{year}-{:02}-{:02}", date.month(), date.day())
}

/// `date` moved by `days` (Go `AddDate(0, 0, days)`). Dates handled here come from
/// `YYYY-MM-DD` input or the database, far inside chrono's range; on overflow the date is
/// returned unchanged.
pub fn add_days(date: NaiveDate, days: i64) -> NaiveDate {
    Duration::try_days(days).and_then(|delta| date.checked_add_signed(delta)).unwrap_or(date)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_go() {
        let d = |y, m, d| NaiveDate::from_ymd_opt(y, m, d).unwrap();
        assert_eq!(format_date(d(2026, 3, 9)), "2026-03-09");
        assert_eq!(format_date(d(10000, 1, 1)), "10000-01-01");
        assert_eq!(format_date(d(0, 1, 1)), "0000-01-01");
        assert_eq!(format_date(d(-1, 12, 31)), "-0001-12-31");
        assert_eq!(add_days(d(2026, 3, 9), -9), d(2026, 2, 28));
    }
}
