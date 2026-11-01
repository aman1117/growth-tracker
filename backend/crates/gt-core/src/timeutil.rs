//! Date/time helpers shared by the services. Dates are IST (Asia/Kolkata) calendar dates, as in
//! the Go backend.

use chrono::{DateTime, Datelike, NaiveDate, Utc};
use chrono_tz::Asia::Kolkata;
use chrono_tz::Tz;

/// The IST time zone.
pub const IST: Tz = Kolkata;

/// Current instant in UTC.
pub fn now() -> DateTime<Utc> {
    Utc::now()
}

/// Current instant in IST.
pub fn now_ist() -> DateTime<Tz> {
    Utc::now().with_timezone(&IST)
}

/// Today's IST calendar date.
pub fn today_ist() -> NaiveDate {
    now_ist().date_naive()
}

/// Today's date in the process time zone (Go `time.Now().Format("2006-01-02")` or
/// `time.Now().Truncate(..)` without an explicit location). Production runs in UTC.
pub fn today_local() -> NaiveDate {
    chrono::Local::now().date_naive()
}

/// Parses `YYYY-MM-DD` strictly, like Go's `time.Parse("2006-01-02", s)`: exactly two-digit
/// month and day, four-digit year, no surrounding whitespace.
pub fn parse_date(s: &str) -> Option<NaiveDate> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !digits(0..4) || !digits(5..7) || !digits(8..10) {
        return None;
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// Formats a date as `YYYY-MM-DD` (Go: `t.Format("2006-01-02")`).
pub fn format_date(d: &NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// Monday of the ISO week containing `d`.
pub fn week_monday(d: NaiveDate) -> NaiveDate {
    d - chrono::Duration::days(i64::from(d.weekday().num_days_from_monday()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_date_parsing() {
        assert_eq!(parse_date("2026-01-04"), NaiveDate::from_ymd_opt(2026, 1, 4));
        assert_eq!(parse_date("2026-1-04"), None);
        assert_eq!(parse_date("2026-02-30"), None);
        assert_eq!(parse_date(" 2026-01-04"), None);
        assert_eq!(parse_date("2026/01/04"), None);
    }
}
