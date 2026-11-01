//! Go `log` package output: `YYYY/MM/DD HH:MM:SS <message>` lines (local time) on stderr.
//! `log.Fatal*` additionally exits with status 1.

use std::io::Write;

use chrono::{Local, NaiveDateTime};

/// Prints a line like Go's `log.Println` / `log.Printf`.
///
/// ```ignore
/// gt_jobs::go_log!("📋 Found {} users", users.len());
/// ```
#[macro_export]
macro_rules! go_log {
    ($($arg:tt)*) => {
        $crate::cli::golog::write_line(&::std::format!($($arg)*))
    };
}

/// Prints a line like Go's `log.Fatalf` and exits with status 1.
#[macro_export]
macro_rules! go_fatal {
    ($($arg:tt)*) => {{
        $crate::cli::golog::write_line(&::std::format!($($arg)*));
        ::std::process::exit(1)
    }};
}

/// Formats one log line: the `LstdFlags` prefix, the message and a newline unless the message
/// already ends with one.
pub fn format_line(at: NaiveDateTime, message: &str) -> String {
    let mut line = format!("{} {message}", at.format("%Y/%m/%d %H:%M:%S"));
    if !line.ends_with('\n') {
        line.push('\n');
    }
    line
}

/// Writes `message` to stderr with the current local time.
pub fn write_line(message: &str) {
    let line = format_line(Local::now().naive_local(), message);
    let _ = std::io::stderr().lock().write_all(line.as_bytes());
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;

    use super::*;

    #[test]
    fn lines_match_go_log() {
        let at = NaiveDate::from_ymd_opt(2026, 1, 4).unwrap().and_hms_opt(9, 5, 7).unwrap();
        assert_eq!(format_line(at, "✅ Connected to database"), "2026/01/04 09:05:07 ✅ Connected to database\n");
        assert_eq!(format_line(at, ""), "2026/01/04 09:05:07 \n");
        assert_eq!(format_line(at, "\n🎉 Done"), "2026/01/04 09:05:07 \n🎉 Done\n");
        assert_eq!(format_line(at, "done\n"), "2026/01/04 09:05:07 done\n");
    }
}
