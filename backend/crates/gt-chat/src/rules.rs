//! Pure validation and formatting rules of the chat (no I/O).

use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use gt_core::constants as c;

use crate::repository::InboxCursor;

/// A rejected input: answered with `400` and this message and code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalid {
    pub message: &'static str,
    pub code: &'static str,
}

impl Invalid {
    const fn new(message: &'static str, code: &'static str) -> Self {
        Self { message, code }
    }

    pub const fn request(message: &'static str) -> Self {
        Self::new(message, c::ERR_CODE_INVALID_REQUEST)
    }
}

/// The text of a message: NUL characters (which PostgreSQL rejects) are dropped and surrounding
/// whitespace is trimmed; it must then hold 1 to 4000 characters.
pub fn normalize_body(raw: &str) -> Result<String, Invalid> {
    let without_nul: String = raw.chars().filter(|&ch| ch != '\0').collect();
    let body = without_nul.trim();
    if body.is_empty() {
        return Err(Invalid::new("Message cannot be empty", c::ERR_CODE_MESSAGE_EMPTY));
    }
    if body.chars().count() > c::CHAT_MESSAGE_MAX_LENGTH {
        return Err(Invalid::new("Message is too long (max 4000 characters)", c::ERR_CODE_MESSAGE_TOO_LONG));
    }
    Ok(body.to_string())
}

/// The client's idempotency key: optional, trimmed (blank means none), at most 64 visible ASCII
/// characters.
pub fn normalize_client_message_id(raw: Option<&str>) -> Result<Option<String>, Invalid> {
    let Some(id) = raw.map(str::trim).filter(|id| !id.is_empty()) else { return Ok(None) };
    if id.len() > c::CHAT_CLIENT_MESSAGE_ID_MAX_LENGTH || !id.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(Invalid::request("client_message_id must be at most 64 visible ASCII characters"));
    }
    Ok(Some(id.to_string()))
}

/// A reaction: one emoji (a short sequence such as `👍🏽` or `❤️‍🔥`). It must contain a
/// non-ASCII character, no letters, whitespace or control characters, and at most 16 characters
/// (keycaps like `1️⃣` keep their ASCII digit).
pub fn validate_emoji(raw: &str) -> Result<String, Invalid> {
    let emoji = raw.trim();
    let invalid = Invalid::new("Reaction must be a single emoji", c::ERR_CODE_INVALID_REACTION);
    let has_symbol = !emoji.is_ascii();
    let allowed = emoji.chars().all(|ch| !(ch.is_ascii_alphabetic() || ch.is_whitespace() || ch.is_control()));
    if !has_symbol || !allowed || emoji.chars().count() > c::CHAT_REACTION_MAX_CHARS {
        return Err(invalid);
    }
    Ok(emoji.to_string())
}

/// A positive id from a path segment or query value (`None` for anything else).
pub fn parse_id(raw: &str) -> Option<i64> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<i64>().ok().filter(|id| *id > 0)
}

/// A page size: `default` when absent, an error when not a positive integer, capped at `max`.
pub fn page_limit(raw: &str, default: i64, max: i64) -> Result<i64, Invalid> {
    if raw.is_empty() {
        return Ok(default);
    }
    let limit = parse_id(raw).ok_or(Invalid::request("limit must be a positive integer"))?;
    Ok(limit.min(max))
}

/// How a page of messages is selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessagePage {
    /// The newest messages older than the id (or the newest overall).
    Before(Option<i64>),
    /// Messages newer than the id.
    After(i64),
}

/// The paging of `GET /api/chats/{id}/messages` from its `before` / `after` query values.
pub fn message_page(before: &str, after: &str) -> Result<MessagePage, Invalid> {
    match (before.is_empty(), after.is_empty()) {
        (true, true) => Ok(MessagePage::Before(None)),
        (false, true) => {
            parse_id(before).map(|id| MessagePage::Before(Some(id))).ok_or(Invalid::request("Invalid before cursor"))
        }
        (true, false) => match after {
            "0" => Ok(MessagePage::After(0)),
            _ => parse_id(after).map(MessagePage::After).ok_or(Invalid::request("Invalid after cursor")),
        },
        (false, false) => Err(Invalid::request("Use either before or after, not both")),
    }
}

/// Encodes an inbox position as `<updated_at in µs>_<id>`.
pub fn encode_cursor(cursor: InboxCursor) -> String {
    format!("{}_{}", cursor.updated_at.timestamp_micros(), cursor.id)
}

/// Decodes [`encode_cursor`]; `""` is the first page.
pub fn decode_cursor(raw: &str) -> Result<Option<InboxCursor>, Invalid> {
    if raw.is_empty() {
        return Ok(None);
    }
    let invalid = Invalid::request("Invalid cursor");
    let (micros, id) = raw.split_once('_').ok_or(invalid)?;
    let micros: i64 = micros.parse().map_err(|_| invalid)?;
    let id = parse_id(id).ok_or(invalid)?;
    let updated_at = Utc.timestamp_micros(micros).single().ok_or(invalid)?;
    Ok(Some(InboxCursor { updated_at, id }))
}

/// The quoted text of a reply: at most 200 characters, `…` marking a cut.
pub fn reply_preview(body: &str) -> String {
    if body.chars().count() <= c::CHAT_REPLY_PREVIEW_LENGTH {
        return body.to_string();
    }
    let mut preview: String = body.chars().take(c::CHAT_REPLY_PREVIEW_LENGTH - 1).collect();
    preview.push('…');
    preview
}

/// RFC 3339 in UTC with milliseconds, e.g. `2026-11-08T03:15:15.476Z`.
pub fn format_time(at: &DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_are_trimmed_and_bounded() {
        assert_eq!(normalize_body("  hi there \n").unwrap(), "hi there");
        assert_eq!(normalize_body("a\0b").unwrap(), "ab");
        assert_eq!(normalize_body("line 1\n\nline 2").unwrap(), "line 1\n\nline 2");
        assert_eq!(normalize_body(" \n\t ").unwrap_err().code, c::ERR_CODE_MESSAGE_EMPTY);
        assert_eq!(normalize_body("\0").unwrap_err().code, c::ERR_CODE_MESSAGE_EMPTY);
        let max = "é".repeat(c::CHAT_MESSAGE_MAX_LENGTH);
        assert_eq!(normalize_body(&max).unwrap(), max);
        let too_long = format!("{max}x");
        assert_eq!(normalize_body(&too_long).unwrap_err().code, c::ERR_CODE_MESSAGE_TOO_LONG);
    }

    #[test]
    fn client_message_ids() {
        assert_eq!(normalize_client_message_id(None).unwrap(), None);
        assert_eq!(normalize_client_message_id(Some("  ")).unwrap(), None);
        assert_eq!(normalize_client_message_id(Some(" abc-123 ")).unwrap().as_deref(), Some("abc-123"));
        assert!(normalize_client_message_id(Some(&"a".repeat(64))).is_ok());
        assert!(normalize_client_message_id(Some(&"a".repeat(65))).is_err());
        assert!(normalize_client_message_id(Some("a b")).is_err());
        assert!(normalize_client_message_id(Some("ünï")).is_err());
    }

    #[test]
    fn emoji_reactions() {
        for ok in ["❤️", "👍", "👍🏽", "😂", "❤️‍🔥", "1️⃣", "🇮🇳", " 🙏 ", "👨‍👩‍👧‍👦"]
        {
            assert_eq!(validate_emoji(ok).unwrap(), ok.trim(), "{ok}");
        }
        for bad in ["", "  ", "a", "1", "ok👍", "👍 👍", "\u{7}👍", &"😀".repeat(17)] {
            assert_eq!(validate_emoji(bad).unwrap_err().code, c::ERR_CODE_INVALID_REACTION, "{bad:?}");
        }
    }

    #[test]
    fn ids_and_limits() {
        assert_eq!(parse_id("42"), Some(42));
        for bad in ["", "0", "-1", "+1", "1.5", "abc", "99999999999999999999", " 1"] {
            assert_eq!(parse_id(bad), None, "{bad}");
        }
        assert_eq!(page_limit("", 30, 100), Ok(30));
        assert_eq!(page_limit("5", 30, 100), Ok(5));
        assert_eq!(page_limit("500", 30, 100), Ok(100));
        assert!(page_limit("0", 30, 100).is_err());
        assert!(page_limit("x", 30, 100).is_err());
    }

    #[test]
    fn message_pages() {
        assert_eq!(message_page("", ""), Ok(MessagePage::Before(None)));
        assert_eq!(message_page("9", ""), Ok(MessagePage::Before(Some(9))));
        assert_eq!(message_page("", "0"), Ok(MessagePage::After(0)));
        assert_eq!(message_page("", "7"), Ok(MessagePage::After(7)));
        assert!(message_page("x", "").is_err());
        assert!(message_page("", "-1").is_err());
        assert!(message_page("1", "2").is_err());
    }

    #[test]
    fn cursors_round_trip() {
        let at = Utc.timestamp_micros(1_762_550_115_476_123).unwrap();
        let cursor = InboxCursor { updated_at: at, id: 17 };
        let encoded = encode_cursor(cursor);
        assert_eq!(encoded, "1762550115476123_17");
        assert_eq!(decode_cursor(&encoded), Ok(Some(cursor)));
        assert_eq!(decode_cursor(""), Ok(None));
        for bad in ["x", "1_", "_1", "a_1", "1_a", "1_0", "99999999999999999999_1", "9223372036854775807_1"] {
            assert!(decode_cursor(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn previews_and_times() {
        assert_eq!(reply_preview("short"), "short");
        let long = "ab".repeat(150);
        let preview = reply_preview(&long);
        assert_eq!(preview.chars().count(), c::CHAT_REPLY_PREVIEW_LENGTH);
        assert!(preview.ends_with('…'));
        let at = Utc.timestamp_micros(1_762_550_115_476_123).unwrap();
        assert_eq!(format_time(&at), "2025-11-07T21:15:15.476Z");
    }
}
