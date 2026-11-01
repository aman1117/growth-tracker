//! Activity photo endpoints through the router (port of
//! `internal/handlers/activity_photo_test.go`).

mod common;

use std::sync::Arc;

use chrono::{DateTime, Duration, TimeZone, Utc};
use common::*;
use gt_photos::ActivityPhotoService;
use serde_json::json;
use sqlx::PgPool;

/// The test day of the Go suite.
fn photo_day() -> chrono::NaiveDate {
    day(2026, 3, 9)
}

fn base_time() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 3, 9, 8, 0, 0).unwrap()
}

struct Env {
    db: TestDb,
    fake: FakeBlobStore,
    app: App,
    /// A closed pool for the services' user repository: uploads and likes start background
    /// notification work that looks users up first, so it stops right there (Go `quietUsers`).
    quiet: PgPool,
}

impl Env {
    async fn new(test: &str) -> Option<Env> {
        let db = TestDb::new(test).await?;
        let fake = FakeBlobStore::start().await;
        let app = App::new(&db.pool, "development", fake.storage_config());
        let quiet = db.broken().await;
        Some(Env { db, fake, app, quiet })
    }

    fn service_on(&self, photos: &PgPool, follows: &PgPool) -> Arc<ActivityPhotoService> {
        ServicePools { photos, users: &self.quiet, follows, notifs: &self.db.pool }
            .service(Some(self.fake.store(false)))
    }

    fn router(&self) -> axum::Router {
        self.app.photo_router(self.service_on(&self.db.pool, &self.db.pool))
    }

    /// Photo and follow repositories on a closed pool.
    async fn broken_router(&self) -> axum::Router {
        let broken = self.db.broken().await;
        self.app.photo_router(self.service_on(&broken, &broken))
    }

    async fn user(&self) -> (gt_core::models::User, String) {
        let user = create_user(&self.db.pool).await;
        let token = self.app.token(user.id);
        (user, token)
    }

    async fn rows(&self) -> i64 {
        count(&self.db.pool, "SELECT count(*) FROM activity_photos").await
    }
}

async fn upload(
    router: &axum::Router,
    token: &str,
    fields: &[(&str, &str)],
    file: Option<(&str, &[u8])>,
) -> TestResponse {
    let body = multipart(fields, file.map(|(name, data)| ("image", name, data)));
    call(router, "POST", "/api/activity-photo", Some(token), Some(body)).await
}

/// Owned copies of form fields.
fn owned(fields: &[(&'static str, &str)]) -> Vec<(&'static str, String)> {
    fields.iter().map(|(k, v)| (*k, v.to_string())).collect()
}

async fn photo_at(pool: &PgPool, owner: i64, activity: &str, created_at: DateTime<Utc>) -> i64 {
    let photo = seed_photo(pool, owner, activity, photo_day()).await;
    sqlx::query("UPDATE activity_photos SET created_at = $1 WHERE id = $2")
        .bind(created_at)
        .bind(photo.id)
        .execute(pool)
        .await
        .unwrap();
    photo.id
}

/// `<prefix><uuid>.jpg` with a lowercase hyphenated UUID.
fn assert_uuid_blob(url: &str, prefix: &str) {
    let rest = url.strip_prefix(prefix).unwrap_or_else(|| panic!("{url} does not start with {prefix}"));
    let id = rest.strip_suffix(".jpg").unwrap_or_else(|| panic!("{url} is not a .jpg"));
    assert_eq!(id.len(), 36, "{url}");
    assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase() || c == '-'), "{url}");
}

#[test]
fn upload_photo_validation() {
    run(async {
        let Some(env) = Env::new("h_upload_validation").await else { return };
        let router = env.router();
        let (_, token) = env.user().await;
        let yesterday = ist_day(-1).to_string();
        let png = png_bytes(32, 32);
        let valid = [("activity_name", "study"), ("photo_date", yesterday.as_str())];
        let (future, old) = (ist_day(1).to_string(), ist_day(-8).to_string());

        let with_png = |fields: Vec<(&'static str, String)>| (fields, Some(("a.png", png.clone())));
        let cases = [
            (
                "missing activity",
                with_png(vec![("photo_date", yesterday.clone())]),
                "MISSING_FIELDS",
                "activity_name and photo_date are required",
            ),
            (
                "missing date",
                with_png(vec![("activity_name", "study".into())]),
                "MISSING_FIELDS",
                "activity_name and photo_date are required",
            ),
            (
                "bad date",
                with_png(vec![("activity_name", "study".into()), ("photo_date", "yesterday".into())]),
                "INVALID_DATE",
                "Invalid date format, use YYYY-MM-DD",
            ),
            ("missing image", (owned(&valid), None), "INVALID_REQUEST", "No image file provided"),
            (
                "future date",
                with_png(vec![("activity_name", "study".into()), ("photo_date", future)]),
                "INVALID_REQUEST",
                "cannot upload photo for future date",
            ),
            (
                "older than a week",
                with_png(vec![("activity_name", "study".into()), ("photo_date", old)]),
                "INVALID_REQUEST",
                "can only upload photos for the last 7 days",
            ),
            (
                "unsupported file",
                (owned(&valid), Some(("notes.txt", b"hello".to_vec()))),
                "INVALID_REQUEST",
                "failed to process image: unsupported file extension: .txt",
            ),
        ];
        for (name, (fields, file), code, message) in cases {
            eprintln!("case: {name}");
            let fields: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
            let file = file.as_ref().map(|(n, d)| (*n, d.as_slice()));
            upload(&router, &token, &fields, file).await.assert_error(400, code, message);
        }
        // Bodies over Fiber's 4 MiB limit never reach the 5 MB check.
        let big = vec![0xFF; gt_core::constants::MAX_PROFILE_PIC_SIZE + 1];
        let res = upload(&router, &token, &valid, Some(("big.jpg", &big))).await;
        assert_eq!((res.status, res.body.as_str()), (413, "Request Entity Too Large"));

        assert!(env.fake.blob_names().is_empty());
        assert_eq!(env.rows().await, 0);
        env.db.finish().await;
    });
}

#[test]
fn upload_photo() {
    run(async {
        let Some(env) = Env::new("h_upload").await else { return };
        let router = env.router();
        let (user, token) = env.user().await;
        let day = ist_day(-1).to_string();
        let fields = [("activity_name", "study"), ("photo_date", day.as_str())];

        let res = upload(&router, &token, &fields, Some(("desk.jpg", &jpeg_bytes(1600, 1200)))).await;
        assert_eq!(res.status, 200, "{}", res.body);
        assert!(res.body.starts_with(r#"{"photo":{"id":"#) && res.body.ends_with(r#""success":true}"#), "{}", res.body);
        let body = res.json();
        let photo = &body["photo"];
        assert!(photo["id"].as_i64().unwrap() > 0);
        assert_eq!(photo["user_id"], user.id);
        assert_eq!(photo["activity_name"], "study");
        assert_eq!(photo["photo_date"], format!("{day}T00:00:00Z"));
        assert!(photo.get("activity_icon").is_none());
        let photo_url = photo["photo_url"].as_str().unwrap();
        assert_uuid_blob(photo_url, &format!("{DEV_PREFIX}activity-photos/{}/{day}/study/", user.id));
        assert_eq!(photo["thumbnail_url"], format!("{}_thumb.jpg", photo_url.trim_end_matches(".jpg")));

        let blob_of = |url: &str| format!("{CONTAINER}/{}", url.strip_prefix(DEV_PREFIX).unwrap());
        let full = env.fake.blob(&blob_of(photo_url)).expect("full image uploaded");
        assert_eq!(jpeg_size(&full), (1080, 810));
        let thumb = env.fake.blob(&blob_of(photo["thumbnail_url"].as_str().unwrap())).expect("thumbnail uploaded");
        assert_eq!(jpeg_size(&thumb).0, 150);
        assert_eq!(env.rows().await, 1);

        // The same activity and day again.
        let res = upload(&router, &token, &fields, Some(("again.png", &png_bytes(20, 20)))).await;
        res.assert_error(409, "CONFLICT", "Photo already exists for this activity on this date");

        // Custom tile metadata.
        let activity = format!("custom:{}", uuid::Uuid::new_v4());
        let custom = [
            ("activity_name", activity.as_str()),
            ("photo_date", day.as_str()),
            ("activity_icon", "Guitar"),
            ("activity_color", "#ff0000"),
            ("activity_label", "Guitar practice"),
        ];
        let res = upload(&router, &token, &custom, Some(("guitar.png", &png_bytes(20, 20)))).await;
        assert_eq!(res.status, 200, "{}", res.body);
        let photo = &res.json()["photo"];
        assert_eq!(photo["activity_icon"], "Guitar");
        assert_eq!(photo["activity_color"], "#ff0000");
        assert_eq!(photo["activity_label"], "Guitar practice");

        // Seven days ago is the oldest allowed day.
        let oldest = ist_day(-7).to_string();
        let res = upload(
            &router,
            &token,
            &[("activity_name", "sleep"), ("photo_date", &oldest)],
            Some(("old.png", &png_bytes(20, 20))),
        )
        .await;
        assert_eq!(res.status, 200, "{}", res.body);

        env.db.finish().await;
    });
}

#[test]
fn upload_photo_failures() {
    run(async {
        let Some(env) = Env::new("h_upload_failures").await else { return };
        let router = env.router();
        let (_, token) = env.user().await;
        let day = ist_day(-1).to_string();
        let fields = [("activity_name", "study"), ("photo_date", day.as_str())];
        let png = png_bytes(40, 40);
        let attempt = |router: axum::Router| {
            let (token, png) = (token.clone(), png.clone());
            let fields = fields.map(|(k, v)| (k, v.to_string()));
            async move {
                let fields: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
                upload(&router, &token, &fields, Some(("a.png", &png))).await.error_message(400, "INVALID_REQUEST")
            }
        };

        env.fake.set_fail_put(Some(|_| true));
        assert!(attempt(router.clone()).await.starts_with("failed to upload full image"));
        assert!(env.fake.blob_names().is_empty());

        env.fake.set_fail_put(Some(|name| name.ends_with("_thumb.jpg")));
        assert!(attempt(router.clone()).await.starts_with("failed to upload thumbnail"));
        assert!(env.fake.blob_names().is_empty(), "the full image is removed");
        env.fake.set_fail_put(None);

        let fault = fail_on(&env.db.pool, "INSERT", "activity_photos").await;
        assert_eq!(attempt(router.clone()).await, format!("failed to save photo: {INJECTED}"));
        fault.clear().await;
        assert!(env.fake.blob_names().is_empty(), "both blobs are removed");

        assert!(attempt(env.broken_router().await).await.starts_with("failed to check existing photo"));

        let unconfigured = ServicePools { users: &env.quiet, ..ServicePools::all(&env.db.pool) }.service(None);
        assert_eq!(attempt(env.app.photo_router(unconfigured)).await, "blob storage is not configured");

        assert_eq!(env.rows().await, 0);
        env.db.finish().await;
    });
}

#[test]
fn delete_photo() {
    run(async {
        let Some(env) = Env::new("h_delete").await else { return };
        let router = env.router();
        let ((owner, owner_token), (_, other_token)) = (env.user().await, env.user().await);
        let photo = seed_photo(&env.db.pool, owner.id, "study", photo_day()).await;
        let del = |router: &axum::Router, token: &str, id: &str| {
            let (router, token, uri) = (router.clone(), token.to_string(), format!("/api/activity-photo/{id}"));
            async move { call(&router, "DELETE", &uri, Some(&token), None).await }
        };
        let id = photo.id.to_string();

        del(&router, &owner_token, "abc").await.assert_error(400, "INVALID_REQUEST", "Invalid photo ID");
        del(&router, &owner_token, "999999").await.assert_error(404, "PHOTO_NOT_FOUND", "Photo not found");
        del(&router, &other_token, &id).await.assert_error(
            403,
            "NOT_AUTHORIZED",
            "Not authorized to delete this photo",
        );
        del(&env.broken_router().await, &owner_token, &id).await.assert_error(
            500,
            "DELETE_FAILED",
            "Failed to delete photo",
        );

        del(&router, &owner_token, &id).await.assert_success_message("Photo deleted successfully");
        assert_eq!(env.rows().await, 0);
        assert_eq!(
            env.fake.requests_with("DELETE"),
            [
                format!("{CONTAINER}/{}", photo_blob(owner.id, photo_day(), "study", "full.jpg")),
                format!("{CONTAINER}/{}", photo_blob(owner.id, photo_day(), "study", "thumb.jpg")),
            ]
        );
        env.db.finish().await;
    });
}

#[test]
fn missing_photo_returns_photo_not_found() {
    run(async {
        let Some(env) = Env::new("h_missing").await else { return };
        let router = env.router();
        let (_, token) = env.user().await;
        let missing = "/api/activity-photo/999999";
        for (method, suffix) in [
            ("DELETE", ""),
            ("POST", "/view"),
            ("GET", "/viewers"),
            ("GET", "/interactions"),
            ("POST", "/like"),
            ("DELETE", "/like"),
        ] {
            let res = call(&router, method, &format!("{missing}{suffix}"), Some(&token), None).await;
            res.assert_error(404, "PHOTO_NOT_FOUND", "Photo not found");
        }
        env.db.finish().await;
    });
}

#[test]
fn get_photos() {
    run(async {
        let Some(env) = Env::new("h_get_photos").await else { return };
        let router = env.router();
        let ((owner, owner_token), (fan, fan_token), (_, stranger_token)) =
            (env.user().await, env.user().await, env.user().await);
        follow(&env.db.pool, fan.id, owner.id).await;
        let sleep = seed_photo(&env.db.pool, owner.id, "sleep", photo_day()).await;
        let study = seed_photo(&env.db.pool, owner.id, "study", photo_day()).await;
        seed_photo(&env.db.pool, owner.id, "study", photo_day() + Duration::days(1)).await;
        let query = format!("?user_id={}&date=2026-03-09", owner.id);
        let list = |router: &axum::Router, token: &str, q: &str| {
            let (router, token, uri) = (router.clone(), token.to_string(), format!("/api/activity-photos{q}"));
            async move { call(&router, "GET", &uri, Some(&token), None).await }
        };

        let cases = [
            ("", &owner_token, 400, "MISSING_FIELDS", "user_id and date are required"),
            (&*format!("?user_id={}", owner.id), &owner_token, 400, "MISSING_FIELDS", "user_id and date are required"),
            ("?user_id=abc&date=2026-03-09", &owner_token, 400, "INVALID_REQUEST", "Invalid user_id"),
            (
                &*format!("?user_id={}&date=09.03.2026", owner.id),
                &owner_token,
                400,
                "INVALID_DATE",
                "Invalid date format, use YYYY-MM-DD",
            ),
            (&*query, &stranger_token, 403, "NOT_AUTHORIZED", "You must follow this user to view their stories"),
        ];
        for (q, token, status, code, message) in cases {
            list(&router, token, q).await.assert_error(status, code, message);
        }

        // Own photos are listed without recording views.
        let res = list(&router, &owner_token, &query).await;
        assert_eq!(res.status, 200);
        assert!(res.body.starts_with(r#"{"photos":["#) && res.body.ends_with(r#"],"success":true}"#));
        let ids: Vec<i64> =
            res.json()["photos"].as_array().unwrap().iter().map(|p| p["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, [sleep.id, study.id]);
        assert_eq!(count(&env.db.pool, "SELECT count(*) FROM story_views").await, 0);

        // Followers' views are recorded.
        let res = list(&router, &fan_token, &query).await;
        assert_eq!(res.json()["photos"].as_array().unwrap().len(), 2);
        let views =
            count(&env.db.pool, &format!("SELECT count(*) FROM story_views WHERE viewer_id = {}", fan.id)).await;
        assert_eq!(views, 2);

        // Access check fails.
        let broken = env.db.broken().await;
        let access_broken = env.app.photo_router(env.service_on(&env.db.pool, &broken));
        list(&access_broken, &fan_token, &query).await.assert_error(500, "SERVER_ERROR", "Failed to check access");

        // Listing fails.
        list(&env.broken_router().await, &owner_token, &query).await.assert_error(
            500,
            "FETCH_FAILED",
            "Failed to get photos",
        );

        // An empty day is `[]`.
        let res = list(&router, &owner_token, &format!("?user_id={}&date=2026-01-01", owner.id)).await;
        assert_eq!(res.body, r#"{"photos":[],"success":true}"#);
        env.db.finish().await;
    });
}

#[test]
fn get_following_stories() {
    run(async {
        let Some(env) = Env::new("h_following").await else { return };
        let router = env.router();
        let ((viewer, token), (early, _), (late, _), (unfollowed, _)) =
            (env.user().await, env.user().await, env.user().await, env.user().await);
        follow(&env.db.pool, viewer.id, early.id).await;
        follow(&env.db.pool, viewer.id, late.id).await;
        let seen = photo_at(&env.db.pool, early.id, "sleep", base_time()).await;
        let unseen = photo_at(&env.db.pool, early.id, "study", base_time() + Duration::minutes(1)).await;
        photo_at(&env.db.pool, late.id, "study", base_time() + Duration::minutes(2)).await;
        photo_at(&env.db.pool, unfollowed.id, "study", base_time() + Duration::minutes(3)).await;
        sqlx::query("INSERT INTO story_views (viewer_id, photo_id) VALUES ($1, $2)")
            .bind(viewer.id)
            .bind(seen)
            .execute(&env.db.pool)
            .await
            .unwrap();
        let stories = |q: &str| {
            let (router, token, uri) = (router.clone(), token.clone(), format!("/api/activity-photos/following{q}"));
            async move { call(&router, "GET", &uri, Some(&token), None).await }
        };

        // Followed users, latest upload first.
        let res = stories("?date=2026-03-09").await;
        assert_eq!(res.status, 200);
        let body = res.json();
        assert_eq!(body["success"], true);
        let groups = body["stories"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["user_id"], late.id);
        assert_eq!(groups[1]["username"], early.username);
        let photos = groups[1]["photos"].as_array().unwrap();
        assert_eq!(photos.iter().map(|p| p["id"].as_i64().unwrap()).collect::<Vec<_>>(), [seen, unseen]);
        assert_eq!((photos[0]["viewed"].as_bool(), photos[1]["viewed"].as_bool()), (Some(true), Some(false)));
        assert_eq!(groups[1]["has_unseen"], true);

        // Limit.
        assert_eq!(stories("?date=2026-03-09&limit=1").await.json()["stories"].as_array().unwrap().len(), 1);
        for limit in ["0", "51", "abc"] {
            let res = stories(&format!("?date=2026-03-09&limit={limit}")).await;
            assert_eq!(res.json()["stories"].as_array().unwrap().len(), 2, "invalid limit {limit} falls back to 20");
        }

        // No stories.
        assert_eq!(stories("?date=2026-03-10").await.body, r#"{"stories":null,"success":true}"#);

        // Errors.
        stories("").await.assert_error(400, "MISSING_FIELDS", "date is required");
        stories("?date=tomorrow").await.assert_error(400, "INVALID_DATE", "Invalid date format, use YYYY-MM-DD");
        let broken = env.broken_router().await;
        let res = call(&broken, "GET", "/api/activity-photos/following?date=2026-03-09", Some(&token), None).await;
        res.assert_error(500, "FETCH_FAILED", "Failed to get stories");
        env.db.finish().await;
    });
}

#[test]
fn record_view() {
    run(async {
        let Some(env) = Env::new("h_record_view").await else { return };
        let router = env.router();
        let ((owner, owner_token), (_, viewer_token)) = (env.user().await, env.user().await);
        let photo = seed_photo(&env.db.pool, owner.id, "study", photo_day()).await;
        let view = |router: &axum::Router, token: &str, id: &str| {
            let (router, token, uri) = (router.clone(), token.to_string(), format!("/api/activity-photo/{id}/view"));
            async move { call(&router, "POST", &uri, Some(&token), None).await }
        };
        let id = photo.id.to_string();

        view(&router, &viewer_token, "abc").await.assert_error(400, "INVALID_REQUEST", "Invalid photo ID");
        view(&router, &viewer_token, "999999").await.assert_error(404, "PHOTO_NOT_FOUND", "Photo not found");
        let broken = env.broken_router().await;
        view(&broken, &viewer_token, &id).await.assert_error(500, "SERVER_ERROR", "Failed to record view");

        for token in [&owner_token, &viewer_token, &viewer_token] {
            let res = view(&router, token, &id).await;
            assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true}"#));
        }
        assert_eq!(
            count(&env.db.pool, "SELECT count(*) FROM story_views").await,
            1,
            "own views are not recorded and repeats count once"
        );
        env.db.finish().await;
    });
}

#[test]
fn viewers_and_interactions() {
    run(async {
        let Some(env) = Env::new("h_viewers").await else { return };
        let router = env.router();
        let ((owner, owner_token), (first, _), (second, _), (fan, fan_token), (like_only, _)) =
            (env.user().await, env.user().await, env.user().await, env.user().await, env.user().await);
        let photo = seed_photo(&env.db.pool, owner.id, "study", photo_day()).await;
        for (i, user) in [&first, &second, &fan].into_iter().enumerate() {
            sqlx::query("INSERT INTO story_views (viewer_id, photo_id, viewed_at) VALUES ($1, $2, $3)")
                .bind(user.id)
                .bind(photo.id)
                .bind(base_time() + Duration::hours(i as i64))
                .execute(&env.db.pool)
                .await
                .unwrap();
        }
        for (user, at) in [(&fan, base_time() + Duration::hours(3)), (&like_only, base_time() + Duration::minutes(30))]
        {
            sqlx::query("INSERT INTO story_likes (liker_id, photo_id, liked_at) VALUES ($1, $2, $3)")
                .bind(user.id)
                .bind(photo.id)
                .bind(at.naive_utc())
                .execute(&env.db.pool)
                .await
                .unwrap();
        }
        let get = |router: &axum::Router, token: &str, id: &str, kind: &str, q: &str| {
            let (router, token) = (router.clone(), token.to_string());
            let uri = format!("/api/activity-photo/{id}/{kind}{q}");
            async move { call(&router, "GET", &uri, Some(&token), None).await }
        };
        let id = photo.id.to_string();
        let user_ids = |list: &serde_json::Value| -> Vec<i64> {
            list.as_array().unwrap().iter().map(|v| v["user_id"].as_i64().unwrap()).collect()
        };

        // Viewers, most recent first.
        let body = get(&router, &owner_token, &id, "viewers", "").await.json();
        assert_eq!((body["success"].as_bool(), body["total"].as_i64()), (Some(true), Some(3)));
        assert_eq!(user_ids(&body["viewers"]), [fan.id, second.id, first.id]);
        let page = get(&router, &owner_token, &id, "viewers", "?limit=1&offset=1").await.json();
        assert_eq!((user_ids(&page["viewers"]), page["total"].as_i64()), (vec![second.id], Some(3)));
        for q in ["?limit=0&offset=-1", "?limit=101", "?limit=abc&offset=abc"] {
            assert_eq!(
                user_ids(&get(&router, &owner_token, &id, "viewers", q).await.json()["viewers"]).len(),
                3,
                "{q}"
            );
        }

        // Interactions combine views and likes.
        let res = get(&router, &owner_token, &id, "interactions", "").await;
        assert!(res.body.starts_with(r#"{"interactions":["#) && res.body.ends_with(r#""success":true,"total":4}"#));
        let body = res.json();
        let types: Vec<(i64, String)> = body["interactions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| (i["user_id"].as_i64().unwrap(), i["interaction_type"].as_str().unwrap().to_string()))
            .collect();
        assert_eq!(
            types,
            [
                (fan.id, "both".into()),
                (second.id, "view".into()),
                (like_only.id, "like".into()),
                (first.id, "view".into())
            ]
        );
        // `viewed_at` is a local-zone time; `liked_at` (TIMESTAMP holding UTC) prints as UTC.
        let fan_entry = &body["interactions"][0];
        assert_eq!(fan_entry["viewed_at"], gt_core::gojson::format_go_time(&(base_time() + Duration::hours(2))));
        assert_eq!(fan_entry["liked_at"], gt_core::gojson::format_go_time_utc(&(base_time() + Duration::hours(3))));
        assert_eq!(body["interactions"][1]["liked_at"], "0001-01-01T00:00:00Z");
        let page = get(&router, &owner_token, &id, "interactions", "?limit=2&offset=1").await.json();
        assert_eq!(user_ids(&page["interactions"]), [second.id, like_only.id]);
        for q in ["?limit=0&offset=-1", "?limit=101", "?limit=abc&offset=abc"] {
            let res = get(&router, &owner_token, &id, "interactions", q).await;
            assert_eq!(user_ids(&res.json()["interactions"]).len(), 4, "{q}");
        }

        for (kind, forbidden) in [
            ("viewers", "Only the photo owner can view viewers"),
            ("interactions", "Only the photo owner can view interactions"),
        ] {
            get(&router, &owner_token, "abc", kind, "").await.assert_error(400, "INVALID_REQUEST", "Invalid photo ID");
            get(&router, &owner_token, "999999", kind, "").await.assert_error(
                404,
                "PHOTO_NOT_FOUND",
                "Photo not found",
            );
            get(&router, &fan_token, &id, kind, "").await.assert_error(403, "NOT_AUTHORIZED", forbidden);
        }

        // Database failures.
        let broken = env.broken_router().await;
        get(&broken, &owner_token, &id, "viewers", "").await.assert_error(500, "FETCH_FAILED", "Failed to get viewers");
        get(&broken, &owner_token, &id, "interactions", "").await.assert_error(
            500,
            "FETCH_FAILED",
            "Failed to get interactions",
        );

        // An empty page is `null`.
        let empty = seed_photo(&env.db.pool, owner.id, "sleep", photo_day()).await.id.to_string();
        let res = get(&router, &owner_token, &empty, "viewers", "").await;
        assert_eq!(res.body, r#"{"success":true,"total":0,"viewers":null}"#);
        env.db.finish().await;
    });
}

async fn clear_like_cache(photo_id: i64, user_ids: &[i64]) {
    if redis_ready().await {
        redis_del(&like_count_key(photo_id)).await;
        for &user_id in user_ids {
            redis_del(&liked_by_key(photo_id, user_id)).await;
        }
    }
}

#[test]
fn like_and_unlike() {
    run(async {
        let Some(env) = Env::new("h_like").await else { return };
        let router = env.router();
        let ((owner, owner_token), (fan, fan_token), (_, stranger_token)) =
            (env.user().await, env.user().await, env.user().await);
        follow(&env.db.pool, fan.id, owner.id).await;
        let photo = seed_photo(&env.db.pool, owner.id, "study", photo_day()).await;
        clear_like_cache(photo.id, &[fan.id]).await;
        let id = photo.id.to_string();
        let act = |router: &axum::Router, token: &str, method: &'static str, id: &str| {
            let (router, token, uri) = (router.clone(), token.to_string(), format!("/api/activity-photo/{id}/like"));
            async move { call(&router, method, &uri, Some(&token), None).await }
        };
        let status = || {
            let (router, token, uri) =
                (router.clone(), fan_token.clone(), format!("/api/activity-photo/{id}/like-status"));
            async move {
                let res = call(&router, "GET", &uri, Some(&token), None).await;
                assert_eq!(res.status, 200, "{}", res.body);
                res.body
            }
        };

        for method in ["POST", "DELETE"] {
            act(&router, &fan_token, method, "abc").await.assert_error(400, "INVALID_REQUEST", "Invalid photo ID");
            act(&router, &fan_token, method, "999999").await.assert_error(404, "PHOTO_NOT_FOUND", "Photo not found");
        }
        act(&router, &owner_token, "POST", &id).await.assert_error(
            400,
            "INVALID_REQUEST",
            "Cannot like your own photo",
        );
        act(&router, &stranger_token, "POST", &id).await.assert_error(
            403,
            "NOT_AUTHORIZED",
            "You must follow this user to like their photos",
        );

        // Liking is idempotent and counts as a view.
        for _ in 0..2 {
            let res = act(&router, &fan_token, "POST", &id).await;
            assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true}"#));
        }
        assert_eq!(count(&env.db.pool, "SELECT count(*) FROM story_likes").await, 1);
        let views =
            count(&env.db.pool, &format!("SELECT count(*) FROM story_views WHERE viewer_id = {}", fan.id)).await;
        assert_eq!(views, 1);
        assert_eq!(status().await, r#"{"like_count":1,"liked":true,"success":true}"#);

        // Unlike.
        for _ in 0..2 {
            assert_eq!(act(&router, &fan_token, "DELETE", &id).await.status, 200);
        }
        assert_eq!(count(&env.db.pool, "SELECT count(*) FROM story_likes").await, 0);
        assert_eq!(status().await, r#"{"like_count":0,"liked":false,"success":true}"#);

        // Database failures.
        let broken = env.broken_router().await;
        act(&broken, &fan_token, "POST", &id).await.assert_error(500, "SERVER_ERROR", "Failed to like photo");
        act(&broken, &fan_token, "DELETE", &id).await.assert_error(500, "SERVER_ERROR", "Failed to unlike photo");

        clear_like_cache(photo.id, &[fan.id]).await;
        env.db.finish().await;
    });
}

#[test]
fn get_photo_like_status() {
    run(async {
        let Some(env) = Env::new("h_like_status").await else { return };
        let router = env.router();
        let ((owner, _), (fan, fan_token)) = (env.user().await, env.user().await);
        follow(&env.db.pool, fan.id, owner.id).await;
        let photo = seed_photo(&env.db.pool, owner.id, "study", photo_day()).await;
        clear_like_cache(photo.id, &[fan.id]).await;
        let path = format!("/api/activity-photo/{}/like-status", photo.id);
        let broken = env.broken_router().await;

        let res = call(&router, "GET", "/api/activity-photo/abc/like-status", Some(&fan_token), None).await;
        res.assert_error(400, "INVALID_REQUEST", "Invalid photo ID");
        let res = call(&broken, "GET", &path, Some(&fan_token), None).await;
        res.assert_error(500, "FETCH_FAILED", "Failed to get like status");

        if redis_ready().await {
            // Served from the cache.
            let like = format!("/api/activity-photo/{}/like", photo.id);
            assert_eq!(call(&router, "POST", &like, Some(&fan_token), None).await.status, 200);
            let first = call(&router, "GET", &path, Some(&fan_token), None).await.body;
            assert_eq!(first, r#"{"like_count":1,"liked":true,"success":true}"#);
            assert_eq!(redis_get(&like_count_key(photo.id)).await.as_deref(), Some("1"));
            sqlx::query("DELETE FROM story_likes").execute(&env.db.pool).await.unwrap();
            assert_eq!(call(&router, "GET", &path, Some(&fan_token), None).await.body, first);

            // The like count lookup fails.
            redis_set(&liked_by_key(photo.id, fan.id), "1").await;
            redis_del(&like_count_key(photo.id)).await;
            let res = call(&broken, "GET", &path, Some(&fan_token), None).await;
            res.assert_error(500, "FETCH_FAILED", "Failed to get like count");
        }

        clear_like_cache(photo.id, &[fan.id]).await;
        env.db.finish().await;
    });
}

#[test]
fn like_photo_notifies_the_owner() {
    run(async {
        let Some(env) = Env::new("h_like_notifies").await else { return };
        let svc = ServicePools::all(&env.db.pool).service(Some(env.fake.store(false)));
        let router = env.app.photo_router(svc.clone());
        let (owner, (fan, fan_token)) = (create_user(&env.db.pool).await, env.user().await);
        set_picture(&env.db.pool, fan.id, Some("http://pics.example/fan.jpg"), None).await;
        follow(&env.db.pool, fan.id, owner.id).await;
        let photo = seed_photo(&env.db.pool, owner.id, "study", photo_day()).await;
        clear_like_cache(photo.id, &[fan.id]).await;
        let like = format!("/api/activity-photo/{}/like", photo.id);

        assert_eq!(call(&router, "POST", &like, Some(&fan_token), None).await.status, 200);
        svc.wait_for_background_tasks().await;
        let notifs = notifications_of(&env.db.pool, owner.id).await;
        assert_eq!(notifs.len(), 1);
        assert_eq!(notifs[0].0, "story_liked");
        assert_eq!(notifs[0].2, format!("{} liked your story", fan.username));
        assert_eq!(notifs[0].3["liker_avatar"], "http://pics.example/fan.jpg");
        assert_eq!(
            notifs[0].3,
            json!({
                "liker_id": fan.id, "liker_username": fan.username, "liker_avatar": "http://pics.example/fan.jpg",
                "photo_id": photo.id, "photo_date": "2026-03-09",
            })
        );

        assert_eq!(call(&router, "DELETE", &like, Some(&fan_token), None).await.status, 200);
        assert_eq!(call(&router, "POST", &like, Some(&fan_token), None).await.status, 200);
        svc.wait_for_background_tasks().await;
        assert_eq!(notifications_of(&env.db.pool, owner.id).await.len(), 1, "liking again does not notify twice");

        clear_like_cache(photo.id, &[fan.id]).await;
        stop_notifications(&svc).await;
        env.db.finish().await;
    });
}
