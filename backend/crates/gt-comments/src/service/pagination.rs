//! Cursor and page-size handling of the comment lists. Cursors are comment ids.

use gt_core::constants::{
    COMMENT_LIST_DEFAULT_LIMIT, COMMENT_LIST_MAX_LIMIT, COMMENT_REPLY_DEFAULT_LIMIT, COMMENT_REPLY_MAX_LIMIT,
};
use gt_core::extract::{parse_go_int, parse_go_uint};

/// Default `limit` query value of both list endpoints (Go: `c.Query("limit", "20")`).
pub const DEFAULT_LIMIT_QUERY: &str = "20";

/// Parses the `cursor` query value (`strconv.ParseUint`); empty or invalid means "first page".
pub fn parse_cursor(raw: &str) -> Option<i64> {
    if raw.is_empty() {
        return None;
    }
    parse_go_uint(raw)
}

/// `limit` unless it is not positive or above `max`, in which case `default`.
pub fn clamp_limit(limit: i64, max: i64, default: i64) -> i64 {
    if limit <= 0 || limit > max {
        default
    } else {
        limit
    }
}

/// Page size of a day's top-level comments.
pub fn clamp_list_limit(limit: i64) -> i64 {
    clamp_limit(limit, COMMENT_LIST_MAX_LIMIT, COMMENT_LIST_DEFAULT_LIMIT)
}

/// Page size of a thread's replies.
pub fn clamp_reply_limit(limit: i64) -> i64 {
    clamp_limit(limit, COMMENT_REPLY_MAX_LIMIT, COMMENT_REPLY_DEFAULT_LIMIT)
}

/// Parses a `limit` query value (`strconv.Atoi`, `0` when invalid) for an already defaulted
/// value such as `query.get_or("limit", DEFAULT_LIMIT_QUERY)`, then clamps it.
pub fn parse_limit(raw: &str, clamp: fn(i64) -> i64) -> i64 {
    clamp(parse_go_int(raw).unwrap_or(0))
}

/// For ranked lists, which cannot be paginated by id: drops everything up to and including
/// the comment `cursor` (when positive). An unknown cursor restarts from the first item; the
/// last item as cursor leaves nothing.
pub fn skip_past_ranked_cursor<T>(items: Vec<T>, cursor: Option<i64>, id_of: impl Fn(&T) -> i64) -> Vec<T> {
    let Some(cursor) = cursor.filter(|c| *c > 0) else {
        return items;
    };
    match items.iter().position(|item| id_of(item) == cursor) {
        Some(index) => items.into_iter().skip(index + 1).collect(),
        None => items,
    }
}

/// Keeps the first `limit` items; the flag tells whether more were available.
pub fn split_page<T>(mut items: Vec<T>, limit: i64) -> (Vec<T>, bool) {
    let limit = usize::try_from(limit).unwrap_or(0);
    let has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    (items, has_more)
}

/// Cursor of the next page: the id of the last item, only when more items exist.
pub fn next_cursor(has_more: bool, last_id: Option<i64>) -> Option<i64> {
    if has_more {
        last_id
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors() {
        assert_eq!(parse_cursor(""), None);
        assert_eq!(parse_cursor("15"), Some(15));
        assert_eq!(parse_cursor("0"), Some(0));
        assert_eq!(parse_cursor("-3"), None);
        assert_eq!(parse_cursor("abc"), None);
    }

    #[test]
    fn limits_are_clamped() {
        assert_eq!(parse_limit("20", clamp_list_limit), 20);
        assert_eq!(parse_limit("5", clamp_list_limit), 5);
        assert_eq!(parse_limit("50", clamp_list_limit), 50);
        assert_eq!(parse_limit("51", clamp_list_limit), COMMENT_LIST_DEFAULT_LIMIT);
        assert_eq!(parse_limit("0", clamp_reply_limit), COMMENT_REPLY_DEFAULT_LIMIT);
        assert_eq!(parse_limit("-5", clamp_reply_limit), COMMENT_REPLY_DEFAULT_LIMIT);
        assert_eq!(parse_limit("ten", clamp_reply_limit), COMMENT_REPLY_DEFAULT_LIMIT);
        assert_eq!(clamp_reply_limit(COMMENT_REPLY_MAX_LIMIT + 1), COMMENT_REPLY_DEFAULT_LIMIT);
    }

    #[test]
    fn ranked_cursor_skips_seen_items() {
        let ids = vec![4, 9, 2, 7];
        assert_eq!(skip_past_ranked_cursor(ids.clone(), None, |i| *i), vec![4, 9, 2, 7]);
        assert_eq!(skip_past_ranked_cursor(ids.clone(), Some(0), |i| *i), vec![4, 9, 2, 7]);
        assert_eq!(skip_past_ranked_cursor(ids.clone(), Some(9), |i| *i), vec![2, 7]);
        assert_eq!(skip_past_ranked_cursor(ids.clone(), Some(7), |i| *i), Vec::<i64>::new());
        assert_eq!(skip_past_ranked_cursor(ids, Some(99), |i| *i), vec![4, 9, 2, 7], "unknown cursor restarts");
    }

    #[test]
    fn pages() {
        assert_eq!(split_page(vec![1, 2, 3], 2), (vec![1, 2], true));
        assert_eq!(split_page(vec![1, 2], 2), (vec![1, 2], false));
        assert_eq!(split_page(Vec::<i64>::new(), 2), (vec![], false));
        assert_eq!(next_cursor(true, Some(2)), Some(2));
        assert_eq!(next_cursor(false, Some(2)), None);
        assert_eq!(next_cursor(true, None), None);
    }
}
