//! JSON encoding that matches Go's `encoding/json`, which the frontend has always consumed.
//!
//! Differences from plain `serde_json` that this module removes:
//! * Go escapes `<`, `>`, `&`, U+2028 and U+2029 inside strings (`\u003c`, ...).
//! * Go prints floats without a trailing `.0` (`2` instead of `2.0`) and switches to exponent
//!   form only below 1e-6 or from 1e21 (`1e-7`, `1e+21`).
//! * Go's `time.Time` marshals as RFC 3339 with trailing fractional zeros trimmed, and `DATE`
//!   columns (decoded by pgx as UTC midnight) marshal as `YYYY-MM-DDT00:00:00Z`.
//!
//! Use [`to_vec`] / [`to_string`] for every JSON body sent to clients, and the `serde(with)`
//! helpers below for time fields.

use std::io;

use chrono::{DateTime, FixedOffset, Local, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Timelike, Utc};
use serde::ser::Serialize;
use serde_json::ser::{CharEscape, Formatter};

/// Serializes `value` exactly like Go's `json.Marshal`.
pub fn to_vec<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(256);
    let mut ser = serde_json::Serializer::with_formatter(&mut out, GoFormatter);
    value.serialize(&mut ser)?;
    Ok(out)
}

/// Serializes `value` exactly like Go's `json.Marshal`, as a `String`.
pub fn to_string<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    // GoFormatter only ever writes valid UTF-8.
    to_vec(value).map(|bytes| String::from_utf8(bytes).expect("JSON output is UTF-8"))
}

/// `serde_json` formatter reproducing Go's escaping and number formatting.
#[derive(Clone, Copy, Debug, Default)]
pub struct GoFormatter;

impl Formatter for GoFormatter {
    fn write_f32<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        writer.write_all(format_go_float32(value).as_bytes())
    }

    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(format_go_float64(value).as_bytes())
    }

    fn write_string_fragment<W: ?Sized + io::Write>(&mut self, writer: &mut W, fragment: &str) -> io::Result<()> {
        let mut start = 0;
        for (i, ch) in fragment.char_indices() {
            let escape: Option<&[u8]> = match ch {
                '<' => Some(b"\\u003c"),
                '>' => Some(b"\\u003e"),
                '&' => Some(b"\\u0026"),
                '\u{2028}' => Some(b"\\u2028"),
                '\u{2029}' => Some(b"\\u2029"),
                _ => None,
            };
            if let Some(escape) = escape {
                writer.write_all(&fragment.as_bytes()[start..i])?;
                writer.write_all(escape)?;
                start = i + ch.len_utf8();
            }
        }
        writer.write_all(&fragment.as_bytes()[start..])
    }

    fn write_char_escape<W: ?Sized + io::Write>(&mut self, writer: &mut W, char_escape: CharEscape) -> io::Result<()> {
        // Same as Go >= 1.22 (which writes \b and \f) and serde_json's default.
        let s: &[u8] = match char_escape {
            CharEscape::Quote => b"\\\"",
            CharEscape::ReverseSolidus => b"\\\\",
            CharEscape::Solidus => b"\\/",
            CharEscape::Backspace => b"\\b",
            CharEscape::FormFeed => b"\\f",
            CharEscape::LineFeed => b"\\n",
            CharEscape::CarriageReturn => b"\\r",
            CharEscape::Tab => b"\\t",
            CharEscape::AsciiControl(byte) => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let bytes = [b'\\', b'u', b'0', b'0', HEX[(byte >> 4) as usize], HEX[(byte & 0xF) as usize]];
                return writer.write_all(&bytes);
            }
        };
        writer.write_all(s)
    }
}

/// Formats an `f64` like Go's `encoding/json` (ES6 number-to-string rules).
pub fn format_go_float64(value: f64) -> String {
    if !value.is_finite() {
        // Go refuses to marshal these; emit null rather than invalid JSON.
        return "null".to_string();
    }
    let abs = value.abs();
    if abs != 0.0 && !(1e-6..1e21).contains(&abs) {
        exponent_form(format!("{value:e}"))
    } else {
        format!("{value}")
    }
}

/// Formats an `f32` like Go's `encoding/json` (shortest representation for 32-bit floats).
pub fn format_go_float32(value: f32) -> String {
    if !value.is_finite() {
        return "null".to_string();
    }
    let abs = value.abs();
    if abs != 0.0 && !(1e-6..1e21).contains(&abs) {
        exponent_form(format!("{value:e}"))
    } else {
        format!("{value}")
    }
}

/// Rust prints `1e21` / `1e-7`; Go prints `1e+21` / `1e-7`.
fn exponent_form(rust: String) -> String {
    match rust.split_once('e') {
        Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
        _ => rust,
    }
}

// ==================== Time zones ====================
//
// Go keeps a location with every `time.Time`, and the Go backend's values come in two kinds:
// * "local": `time.Now()` and every `TIMESTAMPTZ` value decoded by pgx are in the process time
//   zone (`time.Local`: `$TZ`, else the system zone, else UTC). Production containers run in
//   UTC, so these print with `Z`; on a host in IST they print `+05:30`.
// * "UTC": `DATE` and `TIMESTAMP WITHOUT TIME ZONE` values decoded by pgx, explicit `.UTC()`
//   values and the zero time.
// The default helpers below treat an instant as "local" (what nearly every API field is);
// the `_utc` variants are for the second kind. `chrono::Local` follows the same `$TZ` /
// system zone rules as Go, so both implementations print identical values on any host.

/// The instant in the process time zone (Go `t.In(time.Local)`).
pub fn to_go_local(value: &DateTime<Utc>) -> DateTime<FixedOffset> {
    value.with_timezone(&Local).fixed_offset()
}

fn fraction(nanos: u32) -> String {
    if nanos == 0 {
        return String::new();
    }
    let frac = format!("{nanos:09}");
    format!(".{}", frac.trim_end_matches('0'))
}

fn go_offset(offset_seconds: i32) -> String {
    if offset_seconds == 0 {
        return "Z".to_string();
    }
    let sign = if offset_seconds < 0 { '-' } else { '+' };
    let abs = offset_seconds.unsigned_abs();
    format!("{sign}{:02}:{:02}", abs / 3600, (abs % 3600) / 60)
}

/// Go `time.Time.MarshalJSON` of a local-zone time: RFC 3339 with trailing fractional zeros
/// removed and the local offset (`Z` when it is UTC). The zero time prints
/// `0001-01-01T00:00:00Z`.
pub fn format_go_time(value: &DateTime<Utc>) -> String {
    if is_go_zero_time(value) {
        return format_go_time_utc(value);
    }
    let local = to_go_local(value);
    format!(
        "{}{}{}",
        local.format("%Y-%m-%dT%H:%M:%S"),
        fraction(local.nanosecond() % 1_000_000_000),
        go_offset(local.offset().local_minus_utc())
    )
}

/// Go `time.Time.MarshalJSON` of a UTC time (`...Z`).
pub fn format_go_time_utc(value: &DateTime<Utc>) -> String {
    format!("{}{}Z", value.format("%Y-%m-%dT%H:%M:%S"), fraction(value.nanosecond() % 1_000_000_000))
}

/// Go `t.Format(time.RFC3339)` of a local-zone time (whole seconds, local offset).
pub fn format_rfc3339_local(value: &DateTime<Utc>) -> String {
    let local = to_go_local(value);
    format!("{}{}", local.format("%Y-%m-%dT%H:%M:%S"), go_offset(local.offset().local_minus_utc()))
}

/// Go `t.Format("2006-01-02T15:04:05Z")` of a local-zone time: the local wall clock followed by
/// a literal `Z` (used by the notification and comment DTOs).
pub fn format_local_literal_z(value: &DateTime<Utc>) -> String {
    format!("{}Z", to_go_local(value).format("%Y-%m-%dT%H:%M:%S"))
}

/// Formats a calendar date the way Go marshals a pgx-decoded `DATE` (`2026-01-04T00:00:00Z`).
pub fn format_go_date(value: &NaiveDate) -> String {
    format!("{}T00:00:00Z", value.format("%Y-%m-%d"))
}

/// Go's zero `time.Time` (`0001-01-01T00:00:00Z`), which `omitempty` never omits.
pub fn go_zero_time() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(1, 1, 1, 0, 0, 0).single().expect("year 1 is representable")
}

/// Whether `value` is Go's zero `time.Time`.
pub fn is_go_zero_time(value: &DateTime<Utc>) -> bool {
    *value == go_zero_time()
}

fn parse_rfc3339<E: serde::de::Error>(s: &str) -> Result<DateTime<Utc>, E> {
    parse_rfc3339_offset(s).map(|t| t.with_timezone(&Utc))
}

fn parse_rfc3339_offset<E: serde::de::Error>(s: &str) -> Result<DateTime<FixedOffset>, E> {
    DateTime::parse_from_rfc3339(s).map_err(|e| E::custom(format!("parsing time {s:?}: {e}")))
}

/// `#[serde(with = "gojson::time")]` for `DateTime<Utc>` holding a Go local-zone `time.Time`
/// (database `TIMESTAMPTZ` values, `time.Now()`).
pub mod time {
    use super::*;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format_go_time(value))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
        let s = String::deserialize(d)?;
        parse_rfc3339(&s)
    }
}

/// `#[serde(with = "gojson::time_utc")]` for a Go `time.Time` explicitly in UTC (`.UTC()`).
pub mod time_utc {
    use super::*;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format_go_time_utc(value))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
        let s = String::deserialize(d)?;
        parse_rfc3339(&s)
    }
}

/// `#[serde(with = "gojson::time_opt")]` for `Option<DateTime<Utc>>` (Go `*time.Time`; `None`
/// marshals as `null`). Add `skip_serializing_if = "Option::is_none"` for `omitempty`.
pub mod time_opt {
    use super::*;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<DateTime<Utc>>, s: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(v) => s.serialize_str(&format_go_time(v)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<DateTime<Utc>>, D::Error> {
        match Option::<String>::deserialize(d)? {
            Some(s) => parse_rfc3339(&s).map(Some),
            None => Ok(None),
        }
    }
}

/// `#[serde(with = "gojson::date")]` for `NaiveDate` read from a `DATE` column (Go `time.Time`
/// decoded by pgx, which marshals as `YYYY-MM-DDT00:00:00Z`).
pub mod date {
    use super::*;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &NaiveDate, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format_go_date(value))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<NaiveDate, D::Error> {
        let s = String::deserialize(d)?;
        parse_rfc3339_offset(&s).map(|t| t.date_naive())
    }
}

/// `#[serde(with = "gojson::date_opt")]` for `Option<NaiveDate>` (Go `*time.Time` on a `DATE`).
pub mod date_opt {
    use super::*;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<NaiveDate>, s: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(v) => s.serialize_str(&format_go_date(v)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<NaiveDate>, D::Error> {
        match Option::<String>::deserialize(d)? {
            Some(s) => parse_rfc3339_offset(&s).map(|t| Some(t.date_naive())),
            None => Ok(None),
        }
    }
}

/// `#[serde(with = "gojson::naive_time")]` for `NaiveDateTime` read from a
/// `TIMESTAMP WITHOUT TIME ZONE` column (pgx decodes those as UTC).
pub mod naive_time {
    use super::*;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &NaiveDateTime, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format_go_time_utc(&value.and_utc()))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<NaiveDateTime, D::Error> {
        let s = String::deserialize(d)?;
        parse_rfc3339(&s).map(|t| t.naive_utc())
    }
}

/// RFC 3339 with whole seconds, like Go's `t.UTC().Format(time.RFC3339)`.
pub fn format_rfc3339_seconds(value: &DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;
    use serde_json::json;

    /// The local offset suffix Go would print for `t` on this host.
    fn local_suffix(t: &DateTime<Utc>) -> String {
        go_offset(to_go_local(t).offset().local_minus_utc())
    }

    #[test]
    fn floats_match_go() {
        assert_eq!(format_go_float64(2.0), "2");
        assert_eq!(format_go_float64(2.5), "2.5");
        assert_eq!(format_go_float64(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(format_go_float64(1e21), "1e+21");
        assert_eq!(format_go_float64(1e-7), "1e-7");
        assert_eq!(format_go_float64(-0.0), "-0");
        assert_eq!(format_go_float64(123456789.0), "123456789");
        assert_eq!(format_go_float32(0.1), "0.1");
        assert_eq!(format_go_float32(12.75), "12.75");
        assert_eq!(format_go_float32(24.0), "24");
    }

    #[test]
    fn strings_escape_like_go() {
        let s = to_string(&json!({"b": "a<b>&c\u{2028}", "a": "\u{8}\u{c}\u{1}"})).unwrap();
        assert_eq!(s, r#"{"a":"\b\f\u0001","b":"a\u003cb\u003e\u0026c\u2028"}"#);
    }

    #[test]
    fn utc_times_match_go() {
        let t = Utc.with_ymd_and_hms(2026, 1, 4, 10, 5, 6).unwrap();
        assert_eq!(format_go_time_utc(&t), "2026-01-04T10:05:06Z");
        let t = t + chrono::Duration::microseconds(120);
        assert_eq!(format_go_time_utc(&t), "2026-01-04T10:05:06.00012Z");
        assert_eq!(format_go_time(&go_zero_time()), "0001-01-01T00:00:00Z");
        let d = NaiveDate::from_ymd_opt(2026, 1, 4).unwrap();
        assert_eq!(format_go_date(&d), "2026-01-04T00:00:00Z");
        assert_eq!(format_rfc3339_seconds(&t), "2026-01-04T10:05:06Z");
    }

    #[test]
    fn local_times_use_the_process_zone_like_go() {
        let t = Utc.with_ymd_and_hms(2026, 1, 4, 10, 5, 6).unwrap() + chrono::Duration::milliseconds(250);
        let local = to_go_local(&t);
        let wall = local.format("%Y-%m-%dT%H:%M:%S").to_string();
        assert_eq!(format_go_time(&t), format!("{wall}.25{}", local_suffix(&t)));
        assert_eq!(format_rfc3339_local(&t), format!("{wall}{}", local_suffix(&t)));
        assert_eq!(format_local_literal_z(&t), format!("{wall}Z"));
        // The formatted value always denotes the same instant.
        let parsed = DateTime::parse_from_rfc3339(&format_go_time(&t)).unwrap();
        assert_eq!(parsed.with_timezone(&Utc), t);
    }

    #[test]
    fn go_offsets() {
        assert_eq!(go_offset(0), "Z");
        assert_eq!(go_offset(19800), "+05:30");
        assert_eq!(go_offset(-18000), "-05:00");
    }

    #[test]
    fn date_deserialization_keeps_the_written_calendar_day() {
        #[derive(serde::Deserialize)]
        struct D {
            #[serde(with = "date")]
            day: NaiveDate,
        }
        let d: D = serde_json::from_str(r#"{"day":"2026-01-04T00:00:00+05:30"}"#).unwrap();
        assert_eq!(d.day, NaiveDate::from_ymd_opt(2026, 1, 4).unwrap());
    }

    #[test]
    fn serde_helpers_round_trip() {
        #[derive(Serialize)]
        struct S {
            #[serde(with = "time_utc")]
            at: DateTime<Utc>,
            #[serde(with = "time_opt")]
            maybe: Option<DateTime<Utc>>,
            #[serde(with = "date")]
            day: NaiveDate,
            hours: f32,
        }
        let s = S {
            at: Utc.with_ymd_and_hms(2026, 1, 4, 0, 0, 0).unwrap(),
            maybe: None,
            day: NaiveDate::from_ymd_opt(2026, 2, 3).unwrap(),
            hours: 1.0,
        };
        assert_eq!(
            to_string(&s).unwrap(),
            r#"{"at":"2026-01-04T00:00:00Z","maybe":null,"day":"2026-02-03T00:00:00Z","hours":1}"#
        );
    }
}
