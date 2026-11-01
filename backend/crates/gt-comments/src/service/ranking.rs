//! Ordering of a day's top-level comments.

use chrono::{DateTime, Utc};

use crate::repository::CommentWithAuthor;

/// Sort order of `GET /api/days/{username}/{date}/comments`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CommentSort {
    /// Ranked by likes, recency and verified authors (the default).
    #[default]
    Top,
    /// Newest first, paginated by id.
    Newest,
}

impl CommentSort {
    /// Go: `c.Query("sort", "top")`, anything but `top`/`newest` meaning `top`.
    pub fn from_query(raw: &str) -> Self {
        if raw == "newest" {
            CommentSort::Newest
        } else {
            CommentSort::Top
        }
    }
}

/// Go `time.Duration.Hours()` of the time elapsed between `from` and `to` (saturating like
/// `time.Time.Sub`).
fn hours_between(from: DateTime<Utc>, to: DateTime<Utc>) -> f64 {
    const NANOS_PER_HOUR: i64 = 3_600_000_000_000;
    let delta = to.signed_duration_since(from);
    let nanos = delta.num_nanoseconds().unwrap_or(if delta < chrono::Duration::zero() { i64::MIN } else { i64::MAX });
    (nanos / NANOS_PER_HOUR) as f64 + (nanos % NANOS_PER_HOUR) as f64 / 3.6e12
}

/// Ranking score: `log2(1 + likes)` + recency decay `1 / (1 + hours_age / 6)` + 0.3 for
/// verified authors.
pub fn compute_score(comment: &CommentWithAuthor, now: DateTime<Utc>) -> f64 {
    let like_score = (1.0 + comment.comment.like_count as f64).log2();
    let hours_age = hours_between(comment.comment.created_at, now);
    let recency_score = 1.0 / (1.0 + hours_age / 6.0);
    let verified_boost = if comment.author_verified { 0.3 } else { 0.0 };
    like_score + recency_score + verified_boost
}

/// Sorts by score (highest first), ties broken by id (highest first). Stable, like Go's
/// `sort.SliceStable`.
pub fn rank_comments(comments: &mut Vec<CommentWithAuthor>, now: DateTime<Utc>) {
    let mut scored: Vec<(f64, CommentWithAuthor)> = comments.drain(..).map(|c| (compute_score(&c, now), c)).collect();
    scored.sort_by(
        |(score_a, a), (score_b, b)| {
            if score_a == score_b {
                b.comment.id.cmp(&a.comment.id)
            } else {
                score_b.total_cmp(score_a)
            }
        },
    );
    comments.extend(scored.into_iter().map(|(_, c)| c));
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use chrono::{Duration, NaiveDate};
    use gt_core::models::Comment;

    pub(crate) fn comment_at(id: i64, likes: i64, created_at: DateTime<Utc>, verified: bool) -> CommentWithAuthor {
        CommentWithAuthor {
            comment: Comment {
                id,
                day_owner_id: 1,
                day_date: NaiveDate::from_ymd_opt(2026, 3, 9).unwrap(),
                author_id: 2,
                parent_comment_id: None,
                root_comment_id: None,
                reply_to_user_id: None,
                body: format!("comment {id}"),
                like_count: likes,
                reply_count: 0,
                is_edited: false,
                is_deleted: false,
                deleted_at: None,
                created_at,
                updated_at: created_at,
            },
            author_username: "author".into(),
            author_avatar: None,
            author_avatar_thumb: None,
            author_verified: verified,
        }
    }

    #[test]
    fn ranks_likes_recency_and_verified_authors() {
        let now = Utc::now();
        let c = |id, likes, hours, verified| comment_at(id, likes, now - Duration::hours(hours), verified);
        let mut comments = vec![
            c(1, 0, 72, false),
            c(2, 0, 0, false),
            c(3, 3, 24, false),
            c(4, 0, 0, true),
            c(5, 0, 72, false), // same score as 1: higher id first
        ];
        rank_comments(&mut comments, now);
        let order: Vec<i64> = comments.iter().map(|c| c.comment.id).collect();
        assert_eq!(order, vec![3, 4, 2, 5, 1]);

        let fresh = c(9, 0, 0, false);
        assert!((compute_score(&fresh, now) - 1.0).abs() < 1e-9);
        let liked = c(9, 1, 6, true);
        assert!((compute_score(&liked, now) - (1.0 + 0.5 + 0.3)).abs() < 1e-9);
    }

    #[test]
    fn sort_query_defaults_to_top() {
        assert_eq!(CommentSort::from_query("newest"), CommentSort::Newest);
        assert_eq!(CommentSort::from_query("top"), CommentSort::Top);
        assert_eq!(CommentSort::from_query(""), CommentSort::Top);
        assert_eq!(CommentSort::from_query("Newest"), CommentSort::Top);
    }

    #[test]
    fn hours_match_go_duration_hours() {
        let t = Utc::now();
        assert_eq!(hours_between(t, t + Duration::minutes(90)), 1.5);
        assert_eq!(hours_between(t + Duration::minutes(30), t), -0.5);
    }
}
