//! Redis cache of a day's comment count (`comment_cnt:<owner_id>:<YYYY-MM-DD>`, 5 minutes).
//! Redis is optional: without it every call goes to the database, and cache write failures
//! are ignored, as in Go.

use chrono::NaiveDate;
use gt_core::constants::{COMMENT_COUNT_CACHE_PREFIX, COMMENT_COUNT_CACHE_TTL};
use gt_core::extract::parse_go_int;
use gt_core::timeutil::format_date;
use redis::AsyncCommands;

use crate::repository::CommentRepository;

/// Cache key of a day's comment count.
pub fn comment_count_cache_key(day_owner_id: i64, day_date: NaiveDate) -> String {
    format!("{COMMENT_COUNT_CACHE_PREFIX}{day_owner_id}:{}", format_date(&day_date))
}

/// The cached count, `None` without Redis, on a miss, a Redis error or a non-integer value.
pub async fn get_cached_count(day_owner_id: i64, day_date: NaiveDate) -> Option<i64> {
    let mut conn = gt_core::redis::conn()?;
    let value: Option<String> = conn.get(comment_count_cache_key(day_owner_id, day_date)).await.ok()?;
    value.as_deref().and_then(parse_go_int)
}

/// Caches a day's count (errors ignored).
pub async fn set_cached_count(day_owner_id: i64, day_date: NaiveDate, count: i64) {
    if let Some(mut conn) = gt_core::redis::conn() {
        let key = comment_count_cache_key(day_owner_id, day_date);
        let _: Result<(), _> = conn.set_ex(key, count, COMMENT_COUNT_CACHE_TTL.as_secs()).await;
    }
}

/// Drops a day's cached count after a comment is created or deleted (errors ignored).
pub async fn invalidate_count_cache(day_owner_id: i64, day_date: NaiveDate) {
    if let Some(mut conn) = gt_core::redis::conn() {
        let _: Result<(), _> = conn.del(comment_count_cache_key(day_owner_id, day_date)).await;
    }
}

/// A day's non-deleted comment count, served from the cache when possible and cached after a
/// database read (Go `CommentService.GetCommentCount`).
pub async fn get_comment_count(
    repo: &CommentRepository,
    day_owner_id: i64,
    day_date: NaiveDate,
) -> Result<i64, sqlx::Error> {
    if let Some(cached) = get_cached_count(day_owner_id, day_date).await {
        tracing::debug!(day_owner_id, day_date = %day_date, count = cached, "Comment count cache hit");
        return Ok(cached);
    }
    let count = repo.get_comment_count_for_day(day_owner_id, day_date).await?;
    set_cached_count(day_owner_id, day_date, count).await;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_format() {
        let day = NaiveDate::from_ymd_opt(2026, 3, 9).unwrap();
        assert_eq!(comment_count_cache_key(42, day), "comment_cnt:42:2026-03-09");
    }
}
