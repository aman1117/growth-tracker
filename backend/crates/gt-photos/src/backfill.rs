//! Thumbnail backfill for existing profile pictures (port of `cmd/backfill_profile_thumbs`,
//! run by the `backfill_profile_thumbs` binary).
//!
//! Users with a profile picture but no thumbnail are processed in batches of 50: the picture
//! is downloaded from its URL, center-cropped and scaled to a 200 px JPEG (quality 85),
//! uploaded next to the original as `<name>_thumb.jpg` and stored in `profile_pic_thumb`.
//! Processed users drop out of the query, so failed ones are retried on the next run; a batch
//! where every user fails ends the run. Safe to run repeatedly.

use std::time::Duration;

use bytes::Bytes;
use image::{DynamicImage, ImageError, ImageFormat};
use sqlx::PgPool;

use crate::blob::{derive_thumb_blob_name, derive_thumb_url, with_deadline, BlobClient, UPLOAD_TIMEOUT};
use crate::image_processor::{square_thumbnail_jpeg, MIME_JPEG};
use crate::service::DbError;

/// Users per batch.
pub const BATCH_SIZE: i64 = 50;
/// Thumbnail side in pixels.
pub const THUMBNAIL_SIZE: u32 = 200;
/// JPEG quality of the thumbnails.
pub const JPEG_QUALITY: u8 = 85;
/// Timeout of one picture download.
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

const PENDING_USERS_SQL: &str = "SELECT id, profile_pic \
     FROM users \
     WHERE profile_pic IS NOT NULL \
       AND profile_pic != '' \
       AND (profile_pic_thumb IS NULL OR profile_pic_thumb = '') \
     ORDER BY id \
     LIMIT $1";

/// Outcome of a run.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BackfillSummary {
    pub processed: usize,
    /// Users whose thumbnail could not be generated, uploaded or saved.
    pub failed: usize,
}

/// One backfill run over a database and a blob container.
#[derive(Debug, Clone)]
pub struct Backfill {
    pool: PgPool,
    blob: BlobClient,
    container: String,
    http: reqwest::Client,
}

impl Backfill {
    pub fn new(pool: PgPool, blob: BlobClient, container: impl Into<String>) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build()?;
        Ok(Self { pool, blob, container: container.into(), http })
    }

    /// Processes every user missing a thumbnail; progress lines go to `log`. Fails only when
    /// the user query fails.
    pub async fn run(&self, log: &mut dyn FnMut(String)) -> Result<BackfillSummary, DbError> {
        let mut summary = BackfillSummary::default();
        loop {
            let users: Vec<(i64, String)> =
                sqlx::query_as(PENDING_USERS_SQL).bind(BATCH_SIZE).fetch_all(&self.pool).await.map_err(DbError)?;
            if users.is_empty() {
                break;
            }
            log(format!("Processing batch of {} users...", users.len()));

            let mut batch_failed = 0;
            for (user_id, profile_pic) in &users {
                let thumb_url = match self.process_user(profile_pic).await {
                    Ok(url) => url,
                    Err(err) => {
                        log(format!("  SKIP user {user_id}: {err}"));
                        summary.failed += 1;
                        batch_failed += 1;
                        continue;
                    }
                };
                let updated = sqlx::query("UPDATE users SET profile_pic_thumb = $1 WHERE id = $2")
                    .bind(&thumb_url)
                    .bind(user_id)
                    .execute(&self.pool)
                    .await;
                if let Err(err) = updated {
                    log(format!("  FAIL user {user_id}: DB update error: {}", DbError(err)));
                    summary.failed += 1;
                    batch_failed += 1;
                    continue;
                }
                log(format!("  OK user {user_id}: {thumb_url}"));
                summary.processed += 1;
            }

            if batch_failed == users.len() {
                log("Entire batch failed, stopping to avoid infinite loop".to_string());
                break;
            }
        }
        Ok(summary)
    }

    /// Generates and uploads the thumbnail of one picture; returns its URL.
    pub async fn process_user(&self, profile_pic: &str) -> Result<String, String> {
        let response = self.http.get(profile_pic).send().await.map_err(|e| format!("download failed: {e}"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(format!("download returned status {}", response.status().as_u16()));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let data = response.bytes().await.map_err(|e| format!("read body failed: {e}"))?;

        let thumbnail = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
            let image =
                decode(&data, &content_type).map_err(|e| format!("decode failed (type={content_type}): {e}"))?;
            square_thumbnail_jpeg(&image, THUMBNAIL_SIZE, JPEG_QUALITY)
                .map_err(|e| format!("encode thumbnail failed: {e}"))
        })
        .await
        .map_err(|e| format!("thumbnail task failed: {e}"))??;

        let thumb_blob_name = derive_thumb_blob_name(profile_pic, &self.container)?;
        with_deadline(
            UPLOAD_TIMEOUT,
            self.blob.upload(&self.container, &thumb_blob_name, Bytes::from(thumbnail), MIME_JPEG),
        )
        .await
        .map_err(|e| format!("upload thumbnail failed: {e}"))?;
        Ok(derive_thumb_url(profile_pic, &thumb_blob_name, &self.container))
    }
}

/// Decodes by the response `Content-Type` (JPEG, PNG, WebP), otherwise by content sniffing.
fn decode(data: &[u8], content_type: &str) -> Result<DynamicImage, ImageError> {
    let format = if content_type.contains("jpeg") || content_type.contains("jpg") {
        Some(ImageFormat::Jpeg)
    } else if content_type.contains("png") {
        Some(ImageFormat::Png)
    } else if content_type.contains("webp") {
        Some(ImageFormat::WebP)
    } else {
        None
    };
    match format {
        Some(format) => image::load_from_memory_with_format(data, format),
        None => image::load_from_memory(data),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};
    use std::io::Cursor;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(width, height, |x, _| Rgb([(x % 256) as u8, 10, 20]));
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn decodes_by_content_type_or_sniffing() {
        let data = png(30, 20);
        assert_eq!(decode(&data, "image/png").unwrap().width(), 30);
        assert_eq!(decode(&data, "application/octet-stream").unwrap().height(), 20);
        assert!(decode(&data, "image/jpeg").is_err(), "the declared type wins, as in Go");
    }

    #[test]
    fn thumbnails_are_square() {
        let image = decode(&png(300, 120), "").unwrap();
        let jpeg = square_thumbnail_jpeg(&image, THUMBNAIL_SIZE, JPEG_QUALITY).unwrap();
        let thumb = image::load_from_memory_with_format(&jpeg, ImageFormat::Jpeg).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (200, 200));
    }
}
