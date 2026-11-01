//! Path parameters with Fiber semantics: `c.Params` returns the raw (not percent-decoded)
//! segment, and the handlers parse it themselves.

use axum::http::Uri;
use chrono::NaiveDate;
use gt_core::constants as c;
use gt_core::timeutil::parse_date;
use gt_core::ApiError;

/// Segment positions in `/api/days/{username}/{date}/comments/{commentId}/replies`.
const DAY_USERNAME: usize = 3;
const DAY_DATE: usize = 4;
const DAY_COMMENT_ID: usize = 6;
/// Segment position in `/api/comments/{commentId}...`.
const COMMENT_ID: usize = 3;

/// The `index`-th `/`-separated segment of the raw request path, `""` when absent. The router
/// has already matched the route, so positions are fixed.
fn raw_segment(uri: &Uri, index: usize) -> &str {
    uri.path().split('/').nth(index).unwrap_or("")
}

/// `(username, date)` of a day route, raw.
pub(crate) fn day_params(uri: &Uri) -> (&str, &str) {
    (raw_segment(uri, DAY_USERNAME), raw_segment(uri, DAY_DATE))
}

/// The `commentId` of `/api/days/{username}/{date}/comments/{commentId}/replies`, raw.
pub(crate) fn reply_parent_param(uri: &Uri) -> &str {
    raw_segment(uri, DAY_COMMENT_ID)
}

/// The `commentId` of `/api/comments/{commentId}...`, raw.
pub(crate) fn comment_id_param(uri: &Uri) -> &str {
    raw_segment(uri, COMMENT_ID)
}

/// Go: `time.Parse("2006-01-02", date)`.
pub(crate) fn parse_day_date(raw: &str) -> Result<NaiveDate, ApiError> {
    parse_date(raw)
        .ok_or_else(|| ApiError::bad_request("Invalid date format (use YYYY-MM-DD)", c::ERR_CODE_INVALID_DATE))
}

/// Go: `strconv.ParseUint(id, 10, 64)`. Ids beyond `i64::MAX` are valid for Go but can never
/// match a row (Go's lookup then failed and reported "not found"), so they map to an
/// impossible id with the same outcome.
pub(crate) fn parse_comment_id(raw: &str) -> Result<i64, ApiError> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid_comment_id());
    }
    let id = raw.parse::<u64>().map_err(|_| invalid_comment_id())?;
    Ok(i64::try_from(id).unwrap_or(-1))
}

fn invalid_comment_id() -> ApiError {
    ApiError::bad_request("Invalid comment ID", c::ERR_CODE_INVALID_REQUEST)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_are_raw() {
        let uri: Uri = "/api/days/amy%5F1/2026-03-09/comments/12/replies?x=1".parse().unwrap();
        assert_eq!(day_params(&uri), ("amy%5F1", "2026-03-09"));
        assert_eq!(reply_parent_param(&uri), "12");
        let uri: Uri = "/api/comments/7/like".parse().unwrap();
        assert_eq!(comment_id_param(&uri), "7");
        let uri: Uri = "/api/x".parse().unwrap();
        assert_eq!(comment_id_param(&uri), "");
    }

    #[test]
    fn parses_like_go() {
        assert_eq!(parse_comment_id("42").unwrap(), 42);
        assert_eq!(parse_comment_id("18446744073709551615").unwrap(), -1);
        for bad in ["", "abc", "-1", "+1", "1.5", "18446744073709551616", "%31"] {
            let err = parse_comment_id(bad).unwrap_err();
            assert_eq!((err.status.as_u16(), err.message.as_str()), (400, "Invalid comment ID"), "{bad}");
        }
        assert_eq!(parse_day_date("2026-03-09").unwrap(), NaiveDate::from_ymd_opt(2026, 3, 9).unwrap());
        let err = parse_day_date("09-03-2026").unwrap_err();
        assert_eq!(
            (err.message.as_str(), err.code.as_str()),
            ("Invalid date format (use YYYY-MM-DD)", c::ERR_CODE_INVALID_DATE)
        );
    }
}
