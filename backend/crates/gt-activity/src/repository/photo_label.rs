//! Relabeling of activity photos when a custom tile is renamed.
//!
//! The Go `TileConfigService` called `ActivityPhotoRepository.UpdateLabelByActivityName`; that
//! repository lives in the photos crate, which this crate cannot depend on, so the same
//! statement runs here.

use sqlx::PgPool;

/// Writes `activity_photos.activity_label`.
#[derive(Debug, Clone)]
pub struct ActivityPhotoLabels {
    pool: PgPool,
}

impl ActivityPhotoLabels {
    /// A handle over `pool`.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Sets the label of every photo the user took for `activity_name` (Go
    /// `ActivityPhotoRepository.UpdateLabelByActivityName`; the table has no `updated_at`).
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
            .await
            .map(|_| ())
    }
}
