//! `ActivityPhotoService` against PostgreSQL, a fake Blob endpoint, Redis and a recording
//! push publisher (port of `internal/services/activity_photo_service_test.go`).

mod common;

use std::sync::Arc;

use bytes::Bytes;
use chrono::NaiveDate;
use common::*;
use gt_core::config::AzureStorageConfig;
use gt_core::constants::MAX_PROFILE_PIC_SIZE;
use gt_notify::{NotificationRepository, NotificationService};
use gt_photos::repository::ActivityPhotoRepository;
use gt_photos::{ActivityPhotoService, PendingPhotoNotification, PhotoError, PhotoUpload, UploadedFile};
use gt_users::{FollowRepository, UserRepository};
use sqlx::postgres::PgPoolOptions;

fn file(name: &str, data: &[u8]) -> UploadedFile {
    UploadedFile {
        filename: name.into(),
        content_type: String::new(),
        size: data.len() as i64,
        data: Bytes::copy_from_slice(data),
    }
}

fn custom_upload(activity: &str, date: NaiveDate, icon: &str, color: &str, label: &str) -> PhotoUpload {
    PhotoUpload {
        activity_name: activity.into(),
        photo_date: date,
        activity_icon: icon.into(),
        activity_color: color.into(),
        activity_label: label.into(),
    }
}

async fn photo_rows(pool: &sqlx::PgPool) -> i64 {
    count(pool, "SELECT count(*) FROM activity_photos").await
}

#[test]
fn constructor_and_blob_urls() {
    run(async {
        let pool = PgPoolOptions::new().connect_lazy("postgres://nobody@127.0.0.1:9/none").unwrap();
        let fake = FakeBlobStore::start().await;
        let build = |cfg: &AzureStorageConfig, development: bool| {
            ActivityPhotoService::from_config(
                Arc::new(ActivityPhotoRepository::new(pool.clone())),
                Arc::new(UserRepository::new(pool.clone())),
                Arc::new(FollowRepository::new(pool.clone())),
                Arc::new(NotificationService::new(Arc::new(NotificationRepository::new(pool.clone())))),
                cfg,
                development,
            )
        };
        let mut cfg = AzureStorageConfig {
            account_name: "growthacct".into(),
            connection_string: String::new(),
            container_name: CONTAINER.into(),
        };
        assert!(build(&cfg, true).unwrap().blob_store().is_none(), "blob storage is optional");

        cfg.connection_string = fake.connection_string();
        let dev = build(&cfg, true).unwrap();
        let store = dev.blob_store().expect("configured");
        assert_eq!(store.container(), CONTAINER);
        assert_eq!(store.public_url("a/b.jpg"), "http://localhost:10000/devstoreaccount1/profile-pictures/a/b.jpg");
        let prod = build(&cfg, false).unwrap();
        let store = prod.blob_store().unwrap();
        assert_eq!(store.public_url("a/b.jpg"), "https://growthacct.blob.core.windows.net/profile-pictures/a/b.jpg");
        assert_eq!(
            store.blob_name_from_url(
                "https://growthacct.blob.core.windows.net/profile-pictures/activity-photos/1/x.jpg"
            ),
            "activity-photos/1/x.jpg"
        );
        assert_eq!(store.blob_name_from_url("https://elsewhere.example.com/x.jpg"), "");

        cfg.connection_string = "not-a-connection-string".into();
        let err = build(&cfg, true).unwrap_err();
        assert!(err.to_string().starts_with("failed to create blob client"), "{err}");
    });
}

#[test]
fn upload() {
    run(async {
        let _serial = serial().await;
        let Some(db) = TestDb::new("svc_upload").await else { return };
        let fake = FakeBlobStore::start().await;
        let svc = ServicePools::all(&db.pool).service(Some(fake.store(false)));
        let user = create_user(&db.pool).await;
        let today = ist_day(0);
        let img = jpeg_bytes(64, 48);

        let photo = svc.upload(user.id, &PhotoUpload::new("study", today), &file("desk.jpg", &img)).await.unwrap();
        assert!(photo.id > 0);
        let prefix = format!("{DEV_PREFIX}activity-photos/{}/{today}/study/", user.id);
        assert!(photo.photo_url.starts_with(&prefix), "{}", photo.photo_url);
        assert!(photo.photo_url.ends_with(".jpg"));
        assert_eq!(photo.thumbnail_url, format!("{}_thumb.jpg", photo.photo_url.trim_end_matches(".jpg")));
        assert_eq!((&photo.activity_icon, &photo.activity_color, &photo.activity_label), (&None, &None, &None));

        let calls = fake.calls();
        assert_eq!(calls.len(), 2);
        let store = svc.blob_store().unwrap();
        assert_eq!(calls[0].name, format!("{CONTAINER}/{}", store.blob_name_from_url(&photo.photo_url)));
        assert_eq!(calls[1].name, format!("{CONTAINER}/{}", store.blob_name_from_url(&photo.thumbnail_url)));
        for call in &calls {
            assert_eq!(call.method, "PUT");
            assert_eq!(call.content_type, "image/jpeg");
            assert!(call.size > 0);
        }
        let stored = svc.get_by_id(photo.id).await.unwrap().unwrap();
        assert_eq!(stored.photo_url, photo.photo_url);
        assert_eq!(stored.photo_date, today);

        let custom = "custom:3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
        let png = png_bytes(20, 30);
        let tile = svc
            .upload(
                user.id,
                &custom_upload(custom, ist_day(-7), "Palette", "#ff8800", "Painting"),
                &file("art.PNG", &png),
            )
            .await
            .unwrap();
        assert_eq!(tile.activity_icon.as_deref(), Some("Palette"));
        assert_eq!(tile.activity_color.as_deref(), Some("#ff8800"));
        assert_eq!(tile.activity_label.as_deref(), Some("Painting"));

        svc.wait_for_background_tasks().await;
        let pending = svc.pending_notification(user.id).await.expect("followers are notified after a debounce window");
        assert_eq!(pending.photo_count, 2, "uploads within the window are batched");
        assert_eq!(pending.uploader_username, user.username);

        let err = svc.upload(user.id, &PhotoUpload::new("study", today), &file("again.jpg", &img)).await.unwrap_err();
        assert!(matches!(err, PhotoError::AlreadyExists));
        assert_eq!(err.to_string(), "photo already exists for this activity on this date");
        assert_eq!(fake.calls().len(), 4, "nothing is uploaded for a duplicate");

        stop_notifications(&svc).await;
        db.finish().await;
    });
}

#[test]
fn upload_rejections() {
    run(async {
        let _serial = serial().await;
        let Some(db) = TestDb::new("svc_upload_rejections").await else { return };
        let fake = FakeBlobStore::start().await;
        let svc = ServicePools::all(&db.pool).service(Some(fake.store(false)));
        let user = create_user(&db.pool).await;
        let today = ist_day(0);
        let img = jpeg_bytes(16, 16);
        let upload = |svc: Arc<ActivityPhotoService>, date: NaiveDate, data: Vec<u8>, name: &'static str, size: i64| {
            let user_id = user.id;
            async move {
                let mut f = file(name, &data);
                f.size = size;
                svc.upload(user_id, &PhotoUpload::new("study", date), &f).await.unwrap_err().to_string()
            }
        };
        let n = img.len() as i64;

        assert_eq!(
            upload(svc.clone(), ist_day(1), img.clone(), "a.jpg", n).await,
            "cannot upload photo for future date"
        );
        assert_eq!(
            upload(svc.clone(), ist_day(-8), img.clone(), "a.jpg", n).await,
            "can only upload photos for the last 7 days"
        );
        let too_large = MAX_PROFILE_PIC_SIZE as i64 + 1;
        assert_eq!(
            upload(svc.clone(), today, img.clone(), "a.jpg", too_large).await,
            "image size must be less than 5MB"
        );
        let junk = b"definitely not an image".to_vec();
        assert!(upload(svc.clone(), today, junk, "a.jpg", 23).await.starts_with("failed to process image"));
        assert!(upload(svc.clone(), today, img.clone(), "a.gif", n).await.contains("unsupported file extension"));

        let broken = db.broken().await;
        let broken_svc =
            ServicePools { photos: &broken, ..ServicePools::all(&db.pool) }.service(Some(fake.store(false)));
        assert!(upload(broken_svc, today, img.clone(), "a.jpg", n).await.starts_with("failed to check existing photo"));

        let unconfigured = ServicePools::all(&db.pool).service(None);
        assert_eq!(upload(unconfigured, today, img.clone(), "a.jpg", n).await, "blob storage is not configured");

        assert!(fake.calls().is_empty());
        assert_eq!(photo_rows(&db.pool).await, 0);
        db.finish().await;
    });
}

#[test]
fn upload_storage_failures() {
    run(async {
        let _serial = serial().await;
        let Some(db) = TestDb::new("svc_upload_storage").await else { return };
        let user = create_user(&db.pool).await;
        let img = jpeg_bytes(16, 16);
        let attempt = |svc: Arc<ActivityPhotoService>| {
            let (user_id, img) = (user.id, img.clone());
            async move { svc.upload(user_id, &PhotoUpload::new("study", ist_day(0)), &file("a.jpg", &img)).await }
        };

        // Full image upload fails.
        let fake = FakeBlobStore::start().await;
        fake.set_fail_put(Some(|name| !name.ends_with("_thumb.jpg")));
        let err = attempt(ServicePools::all(&db.pool).service(Some(fake.store(false)))).await.unwrap_err();
        assert!(err.to_string().starts_with("failed to upload full image"), "{err}");
        assert_eq!(fake.calls().len(), 1);

        // Thumbnail upload fails and the full image is removed.
        let fake = FakeBlobStore::start().await;
        fake.set_fail_put(Some(|name| name.ends_with("_thumb.jpg")));
        let err = attempt(ServicePools::all(&db.pool).service(Some(fake.store(false)))).await.unwrap_err();
        assert!(err.to_string().starts_with("failed to upload thumbnail"), "{err}");
        let calls = fake.calls();
        assert_eq!(calls.len(), 3);
        assert_eq!((calls[2].method.as_str(), &calls[2].name), ("DELETE", &calls[0].name));

        // The database insert fails and both blobs are removed.
        let fake = FakeBlobStore::start().await;
        let fault = fail_on(&db.pool, "INSERT", "activity_photos").await;
        let err = attempt(ServicePools::all(&db.pool).service(Some(fake.store(false)))).await.unwrap_err();
        fault.clear().await;
        assert_eq!(err.to_string(), format!("failed to save photo: {INJECTED}"));
        let calls = fake.blob_requests();
        assert_eq!(calls.len(), 4);
        assert_eq!(calls[2], calls[0].replace("PUT ", "DELETE "));
        assert_eq!(calls[3], calls[1].replace("PUT ", "DELETE "));

        assert_eq!(photo_rows(&db.pool).await, 0);
        db.finish().await;
    });
}

#[test]
fn delete() {
    run(async {
        let _serial = serial().await;
        let Some(db) = TestDb::new("svc_delete").await else { return };
        let fake = FakeBlobStore::start().await;
        let svc = ServicePools::all(&db.pool).service(Some(fake.store(false)));
        let (owner, other) = (create_user(&db.pool).await, create_user(&db.pool).await);
        let today = ist_day(0);

        // The owner deletes the photo and its blobs.
        let photo = seed_photo(&db.pool, owner.id, "study", today).await;
        svc.delete(photo.id, owner.id).await.unwrap();
        assert_eq!(
            fake.blob_requests(),
            [
                format!("DELETE {}", photo_blob(owner.id, today, "study", "full.jpg")),
                format!("DELETE {}", photo_blob(owner.id, today, "study", "thumb.jpg")),
            ]
        );
        assert_eq!(svc.get_by_id(photo.id).await.unwrap(), None);

        // Rules.
        let photo = seed_photo(&db.pool, owner.id, "workout", today).await;
        assert_eq!(
            svc.delete(photo.id, other.id).await.unwrap_err().to_string(),
            "not authorized to delete this photo"
        );
        assert_eq!(svc.delete(999_999, owner.id).await.unwrap_err().to_string(), "photo not found");
        let broken = db.broken().await;
        let broken_svc =
            ServicePools { photos: &broken, ..ServicePools::all(&db.pool) }.service(Some(fake.store(false)));
        assert!(broken_svc
            .delete(photo.id, owner.id)
            .await
            .unwrap_err()
            .to_string()
            .starts_with("failed to get photo"));

        // Blob delete failures do not block the delete.
        let photo = seed_photo(&db.pool, owner.id, "reels", today).await;
        fake.set_fail_delete(Some(|_| true));
        svc.delete(photo.id, owner.id).await.unwrap();
        fake.set_fail_delete(None);
        assert_eq!(svc.get_by_id(photo.id).await.unwrap(), None);

        // Foreign URLs are not touched.
        let photo = seed_photo(&db.pool, owner.id, "family", today).await;
        sqlx::query("UPDATE activity_photos SET photo_url = $1, thumbnail_url = $2 WHERE id = $3")
            .bind("https://cdn.example.com/a.jpg")
            .bind("https://cdn.example.com/b.jpg")
            .bind(photo.id)
            .execute(&db.pool)
            .await
            .unwrap();
        let before = fake.calls().len();
        svc.delete(photo.id, owner.id).await.unwrap();
        assert_eq!(fake.calls().len(), before);

        // The database delete fails.
        let photo = seed_photo(&db.pool, owner.id, "eating", today).await;
        let fault = fail_on(&db.pool, "DELETE", "activity_photos").await;
        let err = svc.delete(photo.id, owner.id).await.unwrap_err();
        fault.clear().await;
        assert_eq!(err.to_string(), format!("failed to delete photo: {INJECTED}"));

        db.finish().await;
    });
}

#[test]
fn delete_by_activity() {
    run(async {
        let _serial = serial().await;
        let Some(db) = TestDb::new("svc_delete_by_activity").await else { return };
        let fake = FakeBlobStore::start().await;
        let svc = ServicePools::all(&db.pool).service(Some(fake.store(false)));
        let user = create_user(&db.pool).await;
        let custom = "custom:0b6f8d1e-2c3a-4b5d-9e7f-1a2b3c4d5e6f";
        let today = ist_day(0);
        seed_photo(&db.pool, user.id, custom, today).await;
        seed_photo(&db.pool, user.id, custom, ist_day(-1)).await;
        let keep = seed_photo(&db.pool, user.id, "study", today).await;

        svc.delete_by_activity(user.id, custom).await.unwrap();
        let calls = fake.calls();
        assert_eq!(calls.len(), 4);
        assert!(calls.iter().all(|c| c.method == "DELETE" && c.name.contains(custom)), "{calls:?}");
        let remaining = svc.get_by_user_and_date(user.id, today).await.unwrap();
        assert_eq!(remaining.iter().map(|p| p.id).collect::<Vec<_>>(), [keep.id]);

        let broken = db.broken().await;
        let broken_read =
            ServicePools { photos: &broken, ..ServicePools::all(&db.pool) }.service(Some(fake.store(false)));
        let err = broken_read.delete_by_activity(user.id, "study").await.unwrap_err();
        assert!(err.to_string().starts_with("failed to get photos"), "{err}");
        let fault = fail_on(&db.pool, "DELETE", "activity_photos").await;
        let err = svc.delete_by_activity(user.id, "study").await.unwrap_err();
        fault.clear().await;
        assert_eq!(err.to_string(), format!("failed to delete photos: {INJECTED}"));

        db.finish().await;
    });
}

#[test]
fn stories_and_views() {
    run(async {
        let _serial = serial().await;
        let Some(db) = TestDb::new("svc_stories").await else { return };
        let svc = ServicePools::all(&db.pool).service(None);
        let (viewer, friend, stranger) =
            (create_user(&db.pool).await, create_user(&db.pool).await, create_user(&db.pool).await);
        let today = ist_day(0);
        follow(&db.pool, viewer.id, friend.id).await;
        let first = seed_photo(&db.pool, friend.id, "study", today).await;
        let second = seed_photo(&db.pool, friend.id, "workout", today).await;
        seed_photo(&db.pool, stranger.id, "study", today).await;

        assert!(svc.can_view_stories(viewer.id, viewer.id).await.unwrap());
        assert!(svc.can_view_stories(viewer.id, friend.id).await.unwrap());
        assert!(!svc.can_view_stories(viewer.id, stranger.id).await.unwrap());

        svc.record_view(viewer.id, first.id).await.unwrap();
        svc.record_view(viewer.id, first.id).await.expect("views are recorded once");
        svc.record_view(friend.id, first.id).await.expect("own views are ignored");
        assert_eq!(svc.record_view(viewer.id, 999_999).await.unwrap_err().to_string(), "photo not found");
        assert_eq!(svc.get_view_count(first.id).await.unwrap(), 1);

        let stories = svc.get_following_stories(viewer.id, today, 10).await.unwrap().unwrap();
        assert_eq!(stories.len(), 1);
        assert_eq!(stories[0].user_id, friend.id);
        let photos = stories[0].photos.as_ref().unwrap();
        let viewed: Vec<(i64, bool)> = photos.iter().map(|p| (p.photo.id, p.viewed)).collect();
        assert_eq!(viewed, [(first.id, true), (second.id, false)]);
        assert!(stories[0].has_unseen);

        let (viewers, total) = svc.get_viewers(first.id, friend.id, 10, 0).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(viewers.unwrap()[0].username, viewer.username);
        let err = svc.get_viewers(first.id, viewer.id, 10, 0).await.unwrap_err();
        assert_eq!(err.to_string(), "not authorized to view photo viewers");
        assert_eq!(svc.get_viewers(999_999, friend.id, 10, 0).await.unwrap_err().to_string(), "photo not found");

        let broken = db.broken().await;
        let broken_svc =
            ServicePools { photos: &broken, follows: &broken, ..ServicePools::all(&db.pool) }.service(None);
        assert!(broken_svc.record_view(viewer.id, first.id).await.is_err());
        assert!(broken_svc.get_viewers(first.id, friend.id, 10, 0).await.is_err());
        assert!(broken_svc.can_view_stories(viewer.id, friend.id).await.is_err());

        db.finish().await;
    });
}

#[test]
fn likes() {
    run(async {
        let _serial = serial().await;
        if !redis_ready().await {
            return;
        }
        let Some(db) = TestDb::new("svc_likes").await else { return };
        let pushes = install_push();
        let svc = ServicePools::all(&db.pool).service(None);
        let (owner, fan, stranger) =
            (create_user(&db.pool).await, create_user(&db.pool).await, create_user(&db.pool).await);
        set_picture(&db.pool, fan.id, Some("https://img/fan.jpg"), None).await;
        follow(&db.pool, fan.id, owner.id).await;
        let photo = seed_photo(&db.pool, owner.id, "study", day(2026, 4, 2)).await;
        redis_set(&like_count_key(photo.id), "2").await;
        redis_del(&liked_by_key(photo.id, fan.id)).await;

        svc.like_photo(fan.id, photo.id).await.unwrap();
        svc.wait_for_background_tasks().await;

        assert!(svc.has_liked_photo(fan.id, photo.id).await.unwrap());
        assert_eq!(redis_get(&like_count_key(photo.id)).await.as_deref(), Some("3"), "the cached count is incremented");
        assert_eq!(svc.get_view_count(photo.id).await.unwrap(), 1, "liking counts as viewing");

        let notifs = notifications_of(&db.pool, owner.id).await;
        assert_eq!(notifs.len(), 1);
        let (kind, title, body, metadata) = &notifs[0];
        assert_eq!((kind.as_str(), title.as_str()), ("story_liked", "New Like!"));
        assert_eq!(body, &format!("{} liked your story", fan.username));
        assert_eq!(metadata["photo_id"], photo.id);
        assert_eq!(metadata["photo_date"], "2026-04-02");
        assert_eq!(metadata["liker_avatar"], "https://img/fan.jpg");
        let sent = pushes.sent().await;
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].dedupe_key, format!("story_liked:{}:{}:{}", owner.id, fan.id, photo.id));
        assert_eq!(sent[0].deep_link, format!("/user/{}?date=2026-04-02", fan.username));
        assert_eq!(sent[0].ttl_seconds, 14_400);
        assert!(sent[0].data.as_ref().unwrap().contains_key("notification_id"));

        svc.like_photo(fan.id, photo.id).await.expect("liking twice is a no-op");
        svc.unlike_photo(fan.id, photo.id).await.unwrap();
        assert!(!svc.has_liked_photo(fan.id, photo.id).await.unwrap());
        assert_eq!(svc.get_photo_like_count(photo.id).await.unwrap(), 2, "the cached count is decremented");

        pushes.clear();
        svc.like_photo(fan.id, photo.id).await.expect("re-like after unlike");
        svc.wait_for_background_tasks().await;
        assert_eq!(notifications_of(&db.pool, owner.id).await.len(), 1, "notified only once per liker and photo");
        assert!(pushes.sent().await.is_empty());

        let (likers, total) = svc.get_photo_likers(photo.id, owner.id, 10, 0).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(likers.unwrap()[0].user_id, fan.id);
        let (interactions, total) = svc.get_photo_interactions(photo.id, owner.id, 10, 0).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(interactions.unwrap()[0].interaction_type, "both");

        let msg = |r: Result<(), PhotoError>| r.unwrap_err().to_string();
        assert_eq!(msg(svc.like_photo(owner.id, photo.id).await), "cannot like own photo");
        assert_eq!(msg(svc.like_photo(stranger.id, photo.id).await), "must follow user to like their photos");
        assert_eq!(msg(svc.like_photo(fan.id, 999_999).await), "photo not found");
        assert_eq!(msg(svc.unlike_photo(fan.id, 999_999).await), "photo not found");
        let err = svc.get_photo_likers(photo.id, fan.id, 10, 0).await.unwrap_err();
        assert_eq!(err.to_string(), "not authorized to view photo likers");
        assert_eq!(svc.get_photo_likers(999_999, owner.id, 10, 0).await.unwrap_err().to_string(), "photo not found");
        let err = svc.get_photo_interactions(photo.id, fan.id, 10, 0).await.unwrap_err();
        assert_eq!(err.to_string(), "not authorized to view photo interactions");
        let err = svc.get_photo_interactions(999_999, owner.id, 10, 0).await.unwrap_err();
        assert_eq!(err.to_string(), "photo not found");

        uninstall_push();
        redis_del(&like_count_key(photo.id)).await;
        redis_del(&liked_by_key(photo.id, fan.id)).await;
        stop_notifications(&svc).await;
        db.finish().await;
    });
}

#[test]
fn like_failures() {
    run(async {
        let _serial = serial().await;
        let redis = redis_ready().await;
        let Some(db) = TestDb::new("svc_like_failures").await else { return };
        let (owner, fan) = (create_user(&db.pool).await, create_user(&db.pool).await);
        follow(&db.pool, fan.id, owner.id).await;
        let photo = seed_photo(&db.pool, owner.id, "study", ist_day(0)).await;
        let likes = || count(&db.pool, "SELECT count(*) FROM story_likes");
        if redis {
            redis_del(&like_count_key(photo.id)).await;
            redis_del(&liked_by_key(photo.id, fan.id)).await;
        }
        let broken = db.broken().await;

        // Photo lookup.
        let svc = ServicePools { photos: &broken, ..ServicePools::all(&db.pool) }.service(None);
        assert!(svc.like_photo(fan.id, photo.id).await.unwrap_err().to_string().starts_with("failed to get photo"));
        assert!(svc.unlike_photo(fan.id, photo.id).await.unwrap_err().to_string().starts_with("failed to get photo"));
        assert!(svc.get_photo_likers(photo.id, owner.id, 10, 0).await.is_err());
        assert!(svc.get_photo_interactions(photo.id, owner.id, 10, 0).await.is_err());
        assert!(svc.has_liked_photo(fan.id, photo.id).await.is_err());
        assert!(svc.get_photo_like_count(photo.id).await.is_err());

        // Permission lookup.
        let svc = ServicePools { follows: &broken, ..ServicePools::all(&db.pool) }.service(None);
        let err = svc.like_photo(fan.id, photo.id).await.unwrap_err();
        assert!(err.to_string().starts_with("failed to check permissions"), "{err}");

        // Like insert.
        let svc = ServicePools::all(&db.pool).service(None);
        let fault = fail_on(&db.pool, "INSERT", "story_likes").await;
        let err = svc.like_photo(fan.id, photo.id).await.unwrap_err();
        fault.clear().await;
        assert_eq!(err.to_string(), format!("failed to like photo: {INJECTED}"));
        assert_eq!(likes().await, 0);

        // Unlike delete.
        let fault = fail_on(&db.pool, "DELETE", "story_likes").await;
        let err = svc.unlike_photo(fan.id, photo.id).await.unwrap_err();
        fault.clear().await;
        assert_eq!(err.to_string(), format!("failed to unlike photo: {INJECTED}"));

        // A failing view insert is tolerated.
        let fault = fail_on(&db.pool, "INSERT", "story_views").await;
        svc.like_photo(fan.id, photo.id).await.unwrap();
        svc.wait_for_background_tasks().await;
        fault.clear().await;
        assert_eq!(likes().await, 1);
        assert_eq!(svc.get_view_count(photo.id).await.unwrap(), 0);
        assert_eq!(notifications_of(&db.pool, owner.id).await.len(), 1);

        if redis {
            redis_del(&like_count_key(photo.id)).await;
            redis_del(&liked_by_key(photo.id, fan.id)).await;
        }
        stop_notifications(&svc).await;
        db.finish().await;
    });
}

#[test]
fn like_cache() {
    run(async {
        let _serial = serial().await;
        let Some(db) = TestDb::new("svc_like_cache").await else { return };
        let svc = ServicePools::all(&db.pool).service(None);
        let (owner, fan) = (create_user(&db.pool).await, create_user(&db.pool).await);
        let photo = seed_photo(&db.pool, owner.id, "study", ist_day(0)).await;
        sqlx::query("INSERT INTO story_likes (liker_id, photo_id) VALUES ($1, $2)")
            .bind(fan.id)
            .bind(photo.id)
            .execute(&db.pool)
            .await
            .unwrap();

        // Without Redis.
        without_redis(async {
            assert!(svc.has_liked_photo(fan.id, photo.id).await.unwrap());
            assert_eq!(svc.get_photo_like_count(photo.id).await.unwrap(), 1);
        })
        .await;

        if redis_ready().await {
            let (count_key, owner_key, fan_key) =
                (like_count_key(photo.id), liked_by_key(photo.id, owner.id), liked_by_key(photo.id, fan.id));

            // Misses fill the cache and hits are served from it.
            redis_del(&count_key).await;
            redis_del(&owner_key).await;
            assert!(!svc.has_liked_photo(owner.id, photo.id).await.unwrap());
            assert_eq!(redis_get(&owner_key).await.as_deref(), Some("0"));
            assert_eq!(svc.get_photo_like_count(photo.id).await.unwrap(), 1);
            assert_eq!(redis_get(&count_key).await.as_deref(), Some("1"));
            redis_set(&owner_key, "1").await;
            redis_set(&count_key, "12").await;
            assert!(svc.has_liked_photo(owner.id, photo.id).await.unwrap());
            assert_eq!(svc.get_photo_like_count(photo.id).await.unwrap(), 12);

            // Redis failures fall back to the database.
            redis_wrong_type(&fan_key).await;
            redis_wrong_type(&count_key).await;
            assert!(svc.has_liked_photo(fan.id, photo.id).await.unwrap());
            assert_eq!(svc.get_photo_like_count(photo.id).await.unwrap(), 1);

            for key in [count_key, owner_key, fan_key] {
                redis_del(&key).await;
            }
        }
        db.finish().await;
    });
}

#[test]
fn send_like_notification() {
    run(async {
        let _serial = serial().await;
        let Some(db) = TestDb::new("svc_like_notification").await else { return };
        let svc = ServicePools::all(&db.pool).service(None);
        let (owner, fan) = (create_user(&db.pool).await, create_user(&db.pool).await);
        let photo = seed_photo(&db.pool, owner.id, "study", ist_day(0)).await;

        svc.send_like_notification(999_999, &photo).await;
        assert!(notifications_of(&db.pool, owner.id).await.is_empty(), "unknown liker");

        for table in ["notification_dedupes", "notifications"] {
            let fault = fail_on(&db.pool, "INSERT", table).await;
            svc.send_like_notification(fan.id, &photo).await;
            fault.clear().await;
        }
        assert!(notifications_of(&db.pool, owner.id).await.is_empty());
        assert_eq!(
            count(&db.pool, "SELECT count(*) FROM notification_dedupes").await,
            0,
            "failed attempts leave no dedupe record"
        );

        install_full_push().await;
        svc.send_like_notification(fan.id, &photo).await;
        uninstall_push();
        let notifs = notifications_of(&db.pool, owner.id).await;
        assert_eq!(notifs.len(), 1, "a full push queue does not affect the in-app notification");
        assert_eq!(notifs[0].3["liker_avatar"], "");

        db.finish().await;
    });
}

#[test]
fn photo_notifications() {
    run(async {
        let _serial = serial().await;
        let Some(db) = TestDb::new("svc_photo_notifications").await else { return };
        let svc = ServicePools::all(&db.pool).service(None);
        let uploader = create_user(&db.pool).await;
        set_picture(&db.pool, uploader.id, Some("https://img/up.jpg"), None).await;
        let (fan_a, fan_b) = (create_user(&db.pool).await, create_user(&db.pool).await);
        follow(&db.pool, fan_a.id, uploader.id).await;
        follow(&db.pool, fan_b.id, uploader.id).await;

        // Debounced uploads become one notification per follower.
        let pushes = install_push();
        svc.schedule_notification(uploader.id, "2026-04-05").await;
        svc.schedule_notification(uploader.id, "2026-04-05").await;
        let pending = svc.pending_notification(uploader.id).await.unwrap();
        assert_eq!(pending.photo_count, 2);
        assert_eq!(pending.uploader_avatar, "https://img/up.jpg");
        svc.flush_pending_notifications().await;
        assert_eq!(svc.pending_notification(uploader.id).await, None);

        for fan in [&fan_a, &fan_b] {
            let notifs = notifications_of(&db.pool, fan.id).await;
            assert_eq!(notifs.len(), 1);
            let (kind, title, body, metadata) = &notifs[0];
            assert_eq!((kind.as_str(), title.as_str()), ("photo_uploaded", "New Story!"));
            assert_eq!(body, &format!("{} shared 2 new photos", uploader.username));
            assert_eq!(metadata["photo_count"], 2);
            assert_eq!(metadata["uploader_avatar"], "https://img/up.jpg");
        }
        let sent = pushes.sent().await;
        assert_eq!(sent.len(), 2);
        for push in &sent {
            assert_eq!(push.dedupe_key, format!("photo_uploaded:{}:{}:2026-04-05", push.user_id, uploader.id));
            assert_eq!(push.deep_link, format!("/user/{}?date=2026-04-05", uploader.username));
            assert_eq!(push.ttl_seconds, 14_400);
        }

        // A single photo, an unparsable date and a full push queue.
        install_full_push().await;
        let single = PendingPhotoNotification {
            uploader_id: uploader.id,
            uploader_username: uploader.username.clone(),
            uploader_avatar: String::new(),
            photo_date: "someday".into(),
            photo_count: 1,
        };
        svc.send_photo_notification(&single).await;
        uninstall_push();
        let notifs = notifications_of(&db.pool, fan_a.id).await;
        assert_eq!(notifs.len(), 2);
        assert_eq!(notifs[1].2, format!("{} shared a new photo", uploader.username));

        // An unknown uploader is not scheduled.
        svc.schedule_notification(999_999, "2026-04-05").await;
        assert_eq!(svc.pending_notification(999_999).await, None);

        // No followers, failing follower lookup, failing notification inserts.
        let lonely = create_user(&db.pool).await;
        let before = count(&db.pool, "SELECT count(*) FROM notifications").await;
        svc.send_photo_notification(&PendingPhotoNotification { uploader_id: lonely.id, ..single.clone() }).await;
        let broken = db.broken().await;
        let broken_follows = ServicePools { follows: &broken, ..ServicePools::all(&db.pool) }.service(None);
        broken_follows.send_photo_notification(&single).await;
        let broken_notifs = ServicePools { notifs: &broken, ..ServicePools::all(&db.pool) }.service(None);
        broken_notifs.send_photo_notification(&single).await;
        assert_eq!(count(&db.pool, "SELECT count(*) FROM notifications").await, before);

        stop_notifications(&svc).await;
        db.finish().await;
    });
}
