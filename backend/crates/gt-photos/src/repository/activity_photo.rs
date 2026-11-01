//! `activity_photos`, `story_views` and `story_likes` data access (port of
//! `internal/repository/activity_photo_repository.go`).
//!
//! Go `Raw(...).Scan(&slice)` leaves the slice nil when no row matches, so those methods
//! return `Option<Vec<_>>` (`None` marshals as `null`); GORM `Find` always yields a (possibly
//! empty) `Vec`.

use std::collections::HashSet;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use gt_core::db::is_unique_violation;
use gt_core::gojson::go_zero_time;
use gt_core::models::{ActivityPhoto, ActivityPhotoInStory, PhotoInteraction, PhotoLiker, PhotoViewer, UserStoryGroup};
use sqlx::PgPool;

/// Fields of a new photo (Go creates an `ActivityPhoto` without id / created_at).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewActivityPhoto {
    pub user_id: i64,
    pub activity_name: String,
    pub photo_date: NaiveDate,
    pub photo_url: String,
    pub thumbnail_url: String,
    pub activity_icon: Option<String>,
    pub activity_color: Option<String>,
    pub activity_label: Option<String>,
}

/// Activity photo, view and like queries.
#[derive(Debug, Clone)]
pub struct ActivityPhotoRepository {
    pool: PgPool,
}

/// `story_likes.liked_at` is a timestamp without time zone (read as UTC).
#[derive(sqlx::FromRow)]
struct LikerRow {
    user_id: i64,
    username: String,
    profile_pic: Option<String>,
    profile_pic_thumb: Option<String>,
    liked_at: NaiveDateTime,
}

#[derive(sqlx::FromRow)]
struct InteractionRow {
    user_id: i64,
    username: String,
    profile_pic: Option<String>,
    profile_pic_thumb: Option<String>,
    interaction_type: String,
    viewed_at: Option<DateTime<Utc>>,
    liked_at: Option<NaiveDateTime>,
}

#[derive(sqlx::FromRow, Default)]
struct StoryOwnerRow {
    id: i64,
    username: String,
    profile_pic: Option<String>,
    profile_pic_thumb: Option<String>,
}

fn none_if_empty<T>(rows: Vec<T>) -> Option<Vec<T>> {
    (!rows.is_empty()).then_some(rows)
}

impl ActivityPhotoRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// The underlying pool (Go `GetDB`), used for the story-like notification transaction.
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Inserts a photo. `created_at` is set by the application clock (GORM `autoCreateTime`),
    /// so the returned value keeps full precision like the Go response did.
    pub async fn create(&self, photo: &NewActivityPhoto) -> Result<ActivityPhoto, sqlx::Error> {
        let created_at = Utc::now();
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO activity_photos (user_id, activity_name, photo_date, photo_url, thumbnail_url, \
             activity_icon, activity_color, activity_label, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
        )
        .bind(photo.user_id)
        .bind(&photo.activity_name)
        .bind(photo.photo_date)
        .bind(&photo.photo_url)
        .bind(&photo.thumbnail_url)
        .bind(&photo.activity_icon)
        .bind(&photo.activity_color)
        .bind(&photo.activity_label)
        .bind(created_at)
        .fetch_one(&self.pool)
        .await?;
        Ok(ActivityPhoto {
            id,
            user_id: photo.user_id,
            activity_name: photo.activity_name.clone(),
            photo_date: photo.photo_date,
            photo_url: photo.photo_url.clone(),
            thumbnail_url: photo.thumbnail_url.clone(),
            activity_icon: photo.activity_icon.clone(),
            activity_color: photo.activity_color.clone(),
            activity_label: photo.activity_label.clone(),
            created_at,
        })
    }

    /// `None` when the photo does not exist.
    pub async fn get_by_id(&self, id: i64) -> Result<Option<ActivityPhoto>, sqlx::Error> {
        sqlx::query_as::<_, ActivityPhoto>(&format!(
            "SELECT {} FROM activity_photos WHERE id = $1 ORDER BY id LIMIT 1",
            ActivityPhoto::COLUMNS
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await
    }

    /// A user's photos of one day, by activity name.
    pub async fn get_by_user_and_date(
        &self,
        user_id: i64,
        photo_date: NaiveDate,
    ) -> Result<Vec<ActivityPhoto>, sqlx::Error> {
        sqlx::query_as::<_, ActivityPhoto>(&format!(
            "SELECT {} FROM activity_photos WHERE user_id = $1 AND photo_date = $2 ORDER BY activity_name ASC",
            ActivityPhoto::COLUMNS
        ))
        .bind(user_id)
        .bind(photo_date)
        .fetch_all(&self.pool)
        .await
    }

    /// A user's photos in an inclusive date range, newest day first.
    pub async fn get_by_user_and_date_range(
        &self,
        user_id: i64,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<Vec<ActivityPhoto>, sqlx::Error> {
        sqlx::query_as::<_, ActivityPhoto>(&format!(
            "SELECT {} FROM activity_photos WHERE user_id = $1 AND photo_date >= $2 AND photo_date <= $3 \
             ORDER BY photo_date DESC, activity_name ASC",
            ActivityPhoto::COLUMNS
        ))
        .bind(user_id)
        .bind(start_date)
        .bind(end_date)
        .fetch_all(&self.pool)
        .await
    }

    /// Renames the label of every photo of a (custom) activity.
    pub async fn update_label_by_activity_name(
        &self,
        user_id: i64,
        activity_name: &str,
        new_label: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE activity_photos SET activity_label = $1 WHERE user_id = $2 AND activity_name = $3")
            .bind(new_label)
            .bind(user_id)
            .bind(activity_name)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// A user's photos of one activity, newest day first.
    pub async fn get_by_activity_name(
        &self,
        user_id: i64,
        activity_name: &str,
    ) -> Result<Vec<ActivityPhoto>, sqlx::Error> {
        sqlx::query_as::<_, ActivityPhoto>(&format!(
            "SELECT {} FROM activity_photos WHERE user_id = $1 AND activity_name = $2 ORDER BY photo_date DESC",
            ActivityPhoto::COLUMNS
        ))
        .bind(user_id)
        .bind(activity_name)
        .fetch_all(&self.pool)
        .await
    }

    /// Photos of the day from users the viewer actively follows, newest upload first.
    pub async fn get_following_photos(
        &self,
        viewer_id: i64,
        photo_date: NaiveDate,
        limit: i64,
        offset: i64,
    ) -> Result<Option<Vec<ActivityPhoto>>, sqlx::Error> {
        let rows = sqlx::query_as::<_, ActivityPhoto>(
            "SELECT ap.* FROM activity_photos ap \
             INNER JOIN follow_edges_by_follower fe ON ap.user_id = fe.followee_id \
             WHERE fe.follower_id = $1 \
             AND fe.state = 'ACTIVE' \
             AND ap.photo_date = $2 \
             ORDER BY ap.created_at DESC \
             LIMIT $3 OFFSET $4",
        )
        .bind(viewer_id)
        .bind(photo_date)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;
        Ok(none_if_empty(rows))
    }

    /// One story per followed user with photos that day, users with the latest upload first,
    /// photos oldest first, each flagged as viewed or not. A user whose profile or photos
    /// cannot be loaded is skipped, as in Go; a vanished user yields an empty profile.
    pub async fn get_following_photos_grouped(
        &self,
        viewer_id: i64,
        photo_date: NaiveDate,
        limit: i64,
    ) -> Result<Option<Vec<UserStoryGroup>>, sqlx::Error> {
        let user_ids: Vec<i64> = sqlx::query_scalar(
            "SELECT user_id FROM ( \
                SELECT ap.user_id, MAX(ap.created_at) as latest_upload \
                FROM activity_photos ap \
                INNER JOIN follow_edges_by_follower fe ON ap.user_id = fe.followee_id \
                WHERE fe.follower_id = $1 \
                AND fe.state = 'ACTIVE' \
                AND ap.photo_date = $2 \
                GROUP BY ap.user_id \
                ORDER BY latest_upload DESC \
                LIMIT $3 \
             ) sub",
        )
        .bind(viewer_id)
        .bind(photo_date)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut groups = Vec::new();
        for user_id in user_ids {
            let owner = match sqlx::query_as::<_, StoryOwnerRow>(
                "SELECT id, username, profile_pic, profile_pic_thumb FROM users WHERE id = $1",
            )
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await
            {
                Ok(owner) => owner.unwrap_or_default(),
                Err(_) => continue,
            };

            let photos = match sqlx::query_as::<_, ActivityPhoto>(&format!(
                "SELECT {} FROM activity_photos WHERE user_id = $1 AND photo_date = $2 ORDER BY created_at ASC",
                ActivityPhoto::COLUMNS
            ))
            .bind(user_id)
            .bind(photo_date)
            .fetch_all(&self.pool)
            .await
            {
                Ok(photos) => photos,
                Err(_) => continue,
            };

            // Go ignores this query's error (nothing counts as viewed).
            let viewed: HashSet<i64> = sqlx::query_scalar::<_, i64>(
                "SELECT photo_id FROM story_views \
                 WHERE viewer_id = $1 AND photo_id IN ( \
                    SELECT id FROM activity_photos WHERE user_id = $2 AND photo_date = $3 \
                 )",
            )
            .bind(viewer_id)
            .bind(user_id)
            .bind(photo_date)
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default()
            .into_iter()
            .collect();

            let photos: Vec<ActivityPhotoInStory> = photos
                .into_iter()
                .map(|photo| ActivityPhotoInStory { viewed: viewed.contains(&photo.id), photo })
                .collect();
            let has_unseen = photos.iter().any(|p| !p.viewed);
            groups.push(UserStoryGroup {
                user_id: owner.id,
                username: owner.username,
                profile_pic: owner.profile_pic,
                profile_pic_thumb: owner.profile_pic_thumb,
                photos: Some(photos),
                has_unseen,
            });
        }
        Ok(none_if_empty(groups))
    }

    /// Deletes a photo (its views and likes cascade).
    pub async fn delete(&self, id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM activity_photos WHERE id = $1").bind(id).execute(&self.pool).await?;
        Ok(())
    }

    /// Deletes all of a user's photos of one activity (custom tile removal).
    pub async fn delete_by_user_and_activity(&self, user_id: i64, activity_name: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM activity_photos WHERE user_id = $1 AND activity_name = $2")
            .bind(user_id)
            .bind(activity_name)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn exists(&self, user_id: i64, activity_name: &str, photo_date: NaiveDate) -> Result<bool, sqlx::Error> {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM activity_photos WHERE user_id = $1 AND activity_name = $2 AND photo_date = $3",
        )
        .bind(user_id)
        .bind(activity_name)
        .bind(photo_date)
        .fetch_one(&self.pool)
        .await?;
        Ok(count > 0)
    }

    /// The photo of a user's activity on a day, if any.
    pub async fn get_existing(
        &self,
        user_id: i64,
        activity_name: &str,
        photo_date: NaiveDate,
    ) -> Result<Option<ActivityPhoto>, sqlx::Error> {
        sqlx::query_as::<_, ActivityPhoto>(&format!(
            "SELECT {} FROM activity_photos WHERE user_id = $1 AND activity_name = $2 AND photo_date = $3 \
             ORDER BY id LIMIT 1",
            ActivityPhoto::COLUMNS
        ))
        .bind(user_id)
        .bind(activity_name)
        .bind(photo_date)
        .fetch_optional(&self.pool)
        .await
    }

    // ==================== Story views ====================

    /// Records a view; repeated views are ignored.
    pub async fn record_view(&self, viewer_id: i64, photo_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO story_views (viewer_id, photo_id, viewed_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING",
        )
        .bind(viewer_id)
        .bind(photo_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn has_viewed(&self, viewer_id: i64, photo_id: i64) -> Result<bool, sqlx::Error> {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM story_views WHERE viewer_id = $1 AND photo_id = $2")
            .bind(viewer_id)
            .bind(photo_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(count > 0)
    }

    /// A page of viewers (most recent first) and the total view count (0 when counting fails,
    /// as Go ignored that error).
    pub async fn get_viewers(
        &self,
        photo_id: i64,
        limit: i64,
        offset: i64,
    ) -> Result<(Option<Vec<PhotoViewer>>, i64), sqlx::Error> {
        let viewers = sqlx::query_as::<_, PhotoViewer>(
            "SELECT \
                u.id as user_id, \
                u.username, \
                u.profile_pic, \
                u.profile_pic_thumb, \
                sv.viewed_at \
             FROM story_views sv \
             INNER JOIN users u ON sv.viewer_id = u.id \
             WHERE sv.photo_id = $1 \
             ORDER BY sv.viewed_at DESC \
             LIMIT $2 OFFSET $3",
        )
        .bind(photo_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;
        let total = self.get_view_count(photo_id).await.unwrap_or(0);
        Ok((none_if_empty(viewers), total))
    }

    pub async fn get_view_count(&self, photo_id: i64) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT count(*) FROM story_views WHERE photo_id = $1")
            .bind(photo_id)
            .fetch_one(&self.pool)
            .await
    }

    /// Which of `photo_ids` the viewer has seen (no query for an empty list).
    pub async fn get_viewed_photo_ids(&self, viewer_id: i64, photo_ids: &[i64]) -> Result<Vec<i64>, sqlx::Error> {
        if photo_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_scalar("SELECT photo_id FROM story_views WHERE viewer_id = $1 AND photo_id = ANY($2)")
            .bind(viewer_id)
            .bind(photo_ids)
            .fetch_all(&self.pool)
            .await
    }

    // ==================== Story likes ====================

    /// Records a like; liking twice is not an error (any other failure, e.g. a missing photo,
    /// is). `liked_at` is the UTC wall clock: GORM set `time.Now()` and pgx stores a `TIMESTAMP`
    /// as UTC.
    pub async fn like_photo(&self, liker_id: i64, photo_id: i64) -> Result<(), sqlx::Error> {
        let result = sqlx::query("INSERT INTO story_likes (liker_id, photo_id, liked_at) VALUES ($1, $2, $3)")
            .bind(liker_id)
            .bind(photo_id)
            .bind(Utc::now().naive_utc())
            .execute(&self.pool)
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(err) if is_unique_violation(&err) => Ok(()),
            Err(err) => Err(err),
        }
    }

    pub async fn unlike_photo(&self, liker_id: i64, photo_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM story_likes WHERE liker_id = $1 AND photo_id = $2")
            .bind(liker_id)
            .bind(photo_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn has_liked_photo(&self, liker_id: i64, photo_id: i64) -> Result<bool, sqlx::Error> {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM story_likes WHERE liker_id = $1 AND photo_id = $2")
            .bind(liker_id)
            .bind(photo_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(count > 0)
    }

    /// A page of likers (most recent first) and the total like count (0 when counting fails).
    pub async fn get_photo_likers(
        &self,
        photo_id: i64,
        limit: i64,
        offset: i64,
    ) -> Result<(Option<Vec<PhotoLiker>>, i64), sqlx::Error> {
        let rows = sqlx::query_as::<_, LikerRow>(
            "SELECT \
                u.id as user_id, \
                u.username, \
                u.profile_pic, \
                u.profile_pic_thumb, \
                sl.liked_at \
             FROM story_likes sl \
             INNER JOIN users u ON sl.liker_id = u.id \
             WHERE sl.photo_id = $1 \
             ORDER BY sl.liked_at DESC \
             LIMIT $2 OFFSET $3",
        )
        .bind(photo_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;
        let likers = rows
            .into_iter()
            .map(|r| PhotoLiker {
                user_id: r.user_id,
                username: r.username,
                profile_pic: r.profile_pic,
                profile_pic_thumb: r.profile_pic_thumb,
                liked_at: r.liked_at.and_utc(),
            })
            .collect();
        let total = self.get_photo_like_count(photo_id).await.unwrap_or(0);
        Ok((none_if_empty(likers), total))
    }

    pub async fn get_photo_like_count(&self, photo_id: i64) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT count(*) FROM story_likes WHERE photo_id = $1")
            .bind(photo_id)
            .fetch_one(&self.pool)
            .await
    }

    /// Which of `photo_ids` the user has liked (no query for an empty list).
    pub async fn get_liked_photo_ids(&self, liker_id: i64, photo_ids: &[i64]) -> Result<Vec<i64>, sqlx::Error> {
        if photo_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_scalar("SELECT photo_id::int8 FROM story_likes WHERE liker_id = $1 AND photo_id = ANY($2)")
            .bind(liker_id)
            .bind(photo_ids)
            .fetch_all(&self.pool)
            .await
    }

    /// Viewers and likers combined (latest interaction first) and the number of distinct
    /// users (0 when counting fails). A missing view or like time is Go's zero time.
    ///
    /// `liked_at` is a `TIMESTAMP` holding UTC wall-clock time, so comparing it with `viewed_at`
    /// in the (UTC) session orders by the real time, as Go did against UTC database servers.
    pub async fn get_photo_interactions(
        &self,
        photo_id: i64,
        limit: i64,
        offset: i64,
    ) -> Result<(Option<Vec<PhotoInteraction>>, i64), sqlx::Error> {
        let rows = sqlx::query_as::<_, InteractionRow>(
            "SELECT \
                COALESCE(v.user_id, l.user_id) as user_id, \
                u.username, \
                u.profile_pic, \
                u.profile_pic_thumb, \
                CASE \
                    WHEN v.user_id IS NOT NULL AND l.user_id IS NOT NULL THEN 'both' \
                    WHEN l.user_id IS NOT NULL THEN 'like' \
                    ELSE 'view' \
                END as interaction_type, \
                v.viewed_at, \
                l.liked_at \
             FROM ( \
                SELECT viewer_id as user_id, viewed_at FROM story_views WHERE photo_id = $1 \
             ) v \
             FULL OUTER JOIN ( \
                SELECT liker_id as user_id, liked_at FROM story_likes WHERE photo_id = $2 \
             ) l ON v.user_id = l.user_id \
             INNER JOIN users u ON u.id = COALESCE(v.user_id, l.user_id) \
             ORDER BY COALESCE(l.liked_at, v.viewed_at) DESC \
             LIMIT $3 OFFSET $4",
        )
        .bind(photo_id)
        .bind(photo_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;
        let interactions = rows
            .into_iter()
            .map(|r| PhotoInteraction {
                user_id: r.user_id,
                username: r.username,
                profile_pic: r.profile_pic,
                profile_pic_thumb: r.profile_pic_thumb,
                interaction_type: r.interaction_type,
                viewed_at: r.viewed_at.unwrap_or_else(go_zero_time),
                liked_at: r.liked_at.map(|t| t.and_utc()).unwrap_or_else(go_zero_time),
            })
            .collect();

        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT user_id) FROM ( \
                SELECT viewer_id as user_id FROM story_views WHERE photo_id = $1 \
                UNION \
                SELECT liker_id as user_id FROM story_likes WHERE photo_id = $2 \
             ) combined",
        )
        .bind(photo_id)
        .bind(photo_id)
        .fetch_one(&self.pool)
        .await
        .unwrap_or(0);
        Ok((none_if_empty(interactions), total))
    }
}
