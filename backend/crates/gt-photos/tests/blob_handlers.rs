//! Profile picture endpoints, blob handler setup and route registration (port of
//! `internal/handlers/blob_test.go` plus the route wiring of `routes.go`).

mod common;

use std::sync::Arc;

use common::*;
use gt_photos::{BlobHandler, BlobService, PhotosContext};
use gt_users::UserRepository;
use sqlx::PgPool;

const PROD_PREFIX: &str = "https://devstoreaccount1.blob.core.windows.net/profile-pictures/";

async fn upload_picture(router: &axum::Router, token: &str, filename: &str, data: &[u8]) -> TestResponse {
    let body = multipart(&[], Some(("image", filename, data)));
    call(router, "POST", "/api/profile/upload-picture", Some(token), Some(body)).await
}

async fn picture_of(pool: &PgPool, user_id: i64) -> (Option<String>, Option<String>) {
    let user = get_user(pool, user_id).await;
    (user.profile_pic, user.profile_pic_thumb)
}

/// `<prefix><user>/<uuid>.jpg`.
fn assert_picture_url(url: &str, prefix: &str, user_id: i64) {
    let rest = url.strip_prefix(&format!("{prefix}{user_id}/")).unwrap_or_else(|| panic!("unexpected URL {url}"));
    let id = rest.strip_suffix(".jpg").unwrap_or_else(|| panic!("not a .jpg: {url}"));
    assert!(uuid::Uuid::parse_str(id).is_ok() && id.len() == 36 && id == id.to_lowercase(), "{url}");
}

#[test]
fn new_blob_handler() {
    run(async {
        let pool = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://nobody@127.0.0.1:9/none").unwrap();
        let service = Arc::new(BlobService::new(Arc::new(UserRepository::new(pool)), &no_storage()));

        let disabled = BlobHandler::new(service.clone(), &no_storage(), true).unwrap();
        assert!(!disabled.is_enabled(), "disabled without a connection string");
        disabled.init().await;

        let mut invalid = no_storage();
        invalid.connection_string = "not a connection string".into();
        let err = BlobHandler::new(service.clone(), &invalid, true).unwrap_err();
        assert!(err.to_string().starts_with("failed to create blob client"), "{err}");

        // Creates the container.
        let fake = FakeBlobStore::start().await;
        let handler = BlobHandler::new(service.clone(), &fake.storage_config(), true).unwrap();
        assert!(handler.is_enabled());
        handler.init().await;
        assert_eq!(fake.requests_with("PUT"), [CONTAINER]);

        // An existing container and a failing creation are not errors.
        for (status, code) in [(409, "ContainerAlreadyExists"), (403, "AuthorizationFailure")] {
            let fake = FakeBlobStore::start().await;
            fake.set_container_response(status, code);
            let handler = BlobHandler::new(service.clone(), &fake.storage_config(), true).unwrap();
            handler.init().await;
            assert!(handler.is_enabled());
            assert_eq!(fake.requests_with("PUT"), [CONTAINER]);
        }
    });
}

#[test]
fn routes_are_registered_only_with_blob_storage() {
    run(async {
        let Some(db) = TestDb::new("b_routes").await else { return };
        let user = create_user(&db.pool).await;

        // Disabled: no route at all.
        for storage in [no_storage(), {
            let mut invalid = no_storage();
            invalid.connection_string = "nonsense".into();
            invalid
        }] {
            let app = App::new(&db.pool, "development", storage);
            let photos = app.photos();
            assert!(!photos.profile_pictures_enabled() && !photos.activity_photos_enabled());
            photos.init().await;
            let router = app.router(&photos);
            let token = app.token(user.id);
            for (method, uri) in [
                ("POST", "/api/profile/upload-picture"),
                ("DELETE", "/api/profile/picture"),
                ("POST", "/api/activity-photo"),
                ("GET", "/api/activity-photos/following?date=2026-03-09"),
            ] {
                assert_eq!(call(&router, method, uri, Some(&token), None).await.status, 404, "{method} {uri}");
            }
        }

        // Enabled: the container is created at init.
        let fake = FakeBlobStore::start().await;
        let app = App::new(&db.pool, "development", fake.storage_config());
        let photos: PhotosContext = app.photos();
        assert!(photos.profile_pictures_enabled() && photos.activity_photos_enabled());
        photos.init().await;
        assert_eq!(fake.requests_with("PUT"), [CONTAINER]);
        let router = app.router(&photos);
        let token = app.token(user.id);

        // The `/api/profile` group authenticates every method first, then answers 405.
        let res = call(&router, "GET", "/api/profile/upload-picture", None, None).await;
        res.assert_error(401, "MISSING_AUTH_HEADER", "Missing Authorization Header");
        let res = call(&router, "GET", "/api/profile/upload-picture", Some(&token), None).await;
        assert_eq!((res.status, res.body.as_str()), (405, "Method Not Allowed"));
        assert!(res.headers.get("x-ratelimit-limit").is_none(), "limiters are per route");
        let res = call(&router, "PUT", "/api/profile/picture", None, None).await;
        assert_eq!(res.status, 401);

        // Upload limiter on uploads, API limiter elsewhere.
        let res = call(&router, "POST", "/api/profile/upload-picture", Some(&token), None).await;
        res.assert_error(400, "INVALID_REQUEST", "No image file provided");
        let upload_limit = res.headers["x-ratelimit-limit"].to_str().unwrap().to_string();
        let res = call(&router, "DELETE", "/api/profile/picture", Some(&token), None).await;
        res.assert_success_message("Profile picture deleted successfully");
        let api_limit = res.headers["x-ratelimit-limit"].to_str().unwrap().to_string();
        assert_eq!((upload_limit.as_str(), api_limit.as_str()), ("20", "200"));

        let res = call(&router, "POST", "/api/activity-photo", None, None).await;
        res.assert_error(401, "MISSING_AUTH_HEADER", "Missing Authorization Header");
        let res = call(&router, "POST", "/api/activity-photo", Some(&token), None).await;
        res.assert_error(400, "MISSING_FIELDS", "activity_name and photo_date are required");
        assert_eq!(res.headers["x-ratelimit-limit"], "20");
        let res = call(&router, "GET", "/api/activity-photo/1/like-status", Some(&token), None).await;
        assert_eq!(res.status, 200, "{}", res.body);
        assert_eq!(res.headers["x-ratelimit-limit"], "200");
        let res = call(&router, "GET", "/api/activity-photo/1", None, None).await;
        assert_eq!(res.status, 405, "other methods are not authenticated outside the profile group");

        db.finish().await;
    });
}

#[test]
fn disabled_handler() {
    run(async {
        let Some(db) = TestDb::new("b_disabled").await else { return };
        let app = App::new(&db.pool, "development", no_storage());
        let router = app.blob_router(blob_handler(&db.pool, None));
        let user = create_user(&db.pool).await;
        set_picture(
            &db.pool,
            user.id,
            Some(&format!("{DEV_PREFIX}1/old.jpg")),
            Some(&format!("{DEV_PREFIX}1/old_thumb.jpg")),
        )
        .await;
        let token = app.token(user.id);

        let res = upload_picture(&router, &token, "me.png", &png_bytes(10, 10)).await;
        res.assert_error(503, "SERVER_ERROR", "Profile picture upload is not configured");

        let res = call(&router, "DELETE", "/api/profile/picture", Some(&token), None).await;
        res.assert_success_message("Profile picture deleted successfully");
        assert_eq!(
            picture_of(&db.pool, user.id).await,
            (None, None),
            "cleared even though the blobs cannot be deleted"
        );
        db.finish().await;
    });
}

#[test]
fn upload_profile_picture_validation() {
    run(async {
        let Some(db) = TestDb::new("b_upload_validation").await else { return };
        let fake = FakeBlobStore::start().await;
        let app = App::new(&db.pool, "development", fake.storage_config());
        let router = app.blob_router(blob_handler(&db.pool, Some(fake.store(false))));
        let token = app.token(create_user(&db.pool).await.id);

        // Not a multipart request.
        let json = (br#"{"image":"x"}"#.to_vec(), "application/json".to_string());
        let res = call(&router, "POST", "/api/profile/upload-picture", Some(&token), Some(json)).await;
        res.assert_error(400, "INVALID_REQUEST", "No image file provided");

        // No file part.
        let body = multipart(&[("other", "field")], None);
        let res = call(&router, "POST", "/api/profile/upload-picture", Some(&token), Some(body)).await;
        res.assert_error(400, "INVALID_REQUEST", "No image file provided");

        let cases: [(&str, &[u8], &str); 3] = [
            ("notes.txt", b"hello", "Only JPG, PNG, WebP, and HEIC images are allowed"),
            (
                "fake.png",
                b"definitely not a png",
                "Failed to process image: invalid image file: unsupported image format",
            ),
            (
                "photo.heic",
                HEIC_HEADER,
                "Failed to process image: HEIC/HEIF images are not yet supported, please convert to JPEG or PNG",
            ),
        ];
        for (filename, data, message) in cases {
            upload_picture(&router, &token, filename, data).await.assert_error(400, "INVALID_REQUEST", message);
        }

        // Bodies over Fiber's 4 MiB limit never reach the 5 MB check.
        let big = vec![0xFF; gt_core::constants::MAX_PROFILE_PIC_SIZE + 1];
        let res = upload_picture(&router, &token, "big.jpg", &big).await;
        assert_eq!((res.status, res.body.as_str()), (413, "Request Entity Too Large"));

        // Unknown user.
        let res = upload_picture(&router, &app.token(999_999), "me.png", &png_bytes(10, 10)).await;
        res.assert_error(404, "USER_NOT_FOUND", "User not found");

        assert!(fake.blob_names().is_empty());
        db.finish().await;
    });
}

#[test]
fn upload_profile_picture() {
    run(async {
        let Some(db) = TestDb::new("b_upload").await else { return };
        let fake = FakeBlobStore::start().await;
        let app = App::new(&db.pool, "development", fake.storage_config());
        let router = app.blob_router(blob_handler(&db.pool, Some(fake.store(false))));
        let user = create_user(&db.pool).await;
        set_picture(
            &db.pool,
            user.id,
            Some(&format!("{DEV_PREFIX}1/old.jpg")),
            Some(&format!("{DEV_PREFIX}1/old_thumb.jpg")),
        )
        .await;

        let res = upload_picture(&router, &app.token(user.id), "Me.PNG", &png_bytes(400, 300)).await;
        assert_eq!(res.status, 200, "{}", res.body);
        let body = res.json();
        let (pic, thumb) = (body["profile_pic"].as_str().unwrap(), body["profile_pic_thumb"].as_str().unwrap());
        assert_eq!(res.body, format!(r#"{{"profile_pic":"{pic}","profile_pic_thumb":"{thumb}","success":true}}"#));
        assert_picture_url(pic, DEV_PREFIX, user.id);
        assert_eq!(thumb, format!("{}_thumb.jpg", pic.trim_end_matches(".jpg")));

        let full = fake.blob(&format!("{CONTAINER}/{}", pic.strip_prefix(DEV_PREFIX).unwrap())).expect("full image");
        assert_eq!(jpeg_size(&full).0, 400, "small images are not upscaled");
        let small = fake.blob(&format!("{CONTAINER}/{}", thumb.strip_prefix(DEV_PREFIX).unwrap())).expect("thumbnail");
        assert_eq!(jpeg_size(&small), (200, 200));
        let uploads: Vec<_> = fake.calls().into_iter().filter(|c| c.method == "PUT").collect();
        assert!(uploads.iter().all(|c| c.content_type == "image/jpeg"));

        let mut deleted = fake.requests_with("DELETE");
        deleted.sort();
        assert_eq!(
            deleted,
            [format!("{CONTAINER}/1/old.jpg"), format!("{CONTAINER}/1/old_thumb.jpg")],
            "the previous picture is deleted"
        );
        assert_eq!(picture_of(&db.pool, user.id).await, (Some(pic.to_string()), Some(thumb.to_string())));
        db.finish().await;
    });
}

#[test]
fn upload_profile_picture_production_urls() {
    run(async {
        let Some(db) = TestDb::new("b_upload_prod").await else { return };
        let fake = FakeBlobStore::start().await;
        let app = App::new(&db.pool, "production", fake.storage_config());
        let photos = app.photos();
        let router = app.router(&photos);
        let user = create_user(&db.pool).await;

        let res = upload_picture(&router, &app.token(user.id), "me.jpg", &jpeg_bytes(2000, 1000)).await;
        assert_eq!(res.status, 200, "{}", res.body);
        let pic = res.json()["profile_pic"].as_str().unwrap().to_string();
        assert_picture_url(&pic, PROD_PREFIX, user.id);
        let full = fake.blob(&format!("{CONTAINER}/{}", pic.strip_prefix(PROD_PREFIX).unwrap())).unwrap();
        assert_eq!(jpeg_size(&full), (1080, 540), "large images are resized to 1080px");
        db.finish().await;
    });
}

#[test]
fn upload_profile_picture_failures() {
    run(async {
        let Some(db) = TestDb::new("b_upload_failures").await else { return };
        let fake = FakeBlobStore::start().await;
        let app = App::new(&db.pool, "development", fake.storage_config());
        let router = app.blob_router(blob_handler(&db.pool, Some(fake.store(false))));
        let user = create_user(&db.pool).await;
        let token = app.token(user.id);
        let png = png_bytes(20, 20);

        fake.set_fail_put(Some(|_| true));
        upload_picture(&router, &token, "me.png", &png).await.assert_error(
            500,
            "SERVER_ERROR",
            "Failed to upload image",
        );
        assert!(fake.blob_names().is_empty());

        fake.set_fail_put(Some(|name| name.ends_with("_thumb.jpg")));
        upload_picture(&router, &token, "me.png", &png).await.assert_error(
            500,
            "SERVER_ERROR",
            "Failed to upload image",
        );
        assert!(fake.blob_names().is_empty(), "the full image is removed");
        assert_eq!(fake.requests_with("DELETE").len(), 1);
        fake.set_fail_put(None);

        // Old blobs that cannot be deleted do not block the upload.
        set_picture(
            &db.pool,
            user.id,
            Some(&format!("{DEV_PREFIX}1/gone.jpg")),
            Some(&format!("{DEV_PREFIX}1/gone_thumb.jpg")),
        )
        .await;
        fake.set_fail_delete(Some(|_| true));
        assert_eq!(upload_picture(&router, &token, "me.png", &png).await.status, 200);
        fake.set_fail_delete(None);

        // The profile update fails.
        let fault = fail_on(&db.pool, "UPDATE", "users").await;
        upload_picture(&router, &token, "me.png", &png).await.assert_error(
            500,
            "UPDATE_FAILED",
            "Failed to update profile",
        );
        fault.clear().await;
        db.finish().await;
    });
}

#[test]
fn delete_profile_picture() {
    run(async {
        let Some(db) = TestDb::new("b_delete").await else { return };
        let fake = FakeBlobStore::start().await;
        let app = App::new(&db.pool, "development", fake.storage_config());
        let router = app.blob_router(blob_handler(&db.pool, Some(fake.store(false))));
        let del = |user_id: i64| {
            let (router, token) = (router.clone(), app.token(user_id));
            async move { call(&router, "DELETE", "/api/profile/picture", Some(&token), None).await }
        };

        // Deletes both blobs and clears the profile.
        let user = create_user(&db.pool).await;
        set_picture(
            &db.pool,
            user.id,
            Some(&format!("{DEV_PREFIX}7/pic.jpg")),
            Some(&format!("{DEV_PREFIX}7/pic_thumb.jpg")),
        )
        .await;
        del(user.id).await.assert_success_message("Profile picture deleted successfully");
        assert_eq!(
            fake.requests_with("DELETE"),
            [format!("{CONTAINER}/7/pic.jpg"), format!("{CONTAINER}/7/pic_thumb.jpg")]
        );
        assert_eq!(picture_of(&db.pool, user.id).await, (None, None));

        // Pictures outside the container are not touched.
        let before = fake.requests_with("DELETE").len();
        let user = create_user(&db.pool).await;
        set_picture(&db.pool, user.id, Some("https://cdn.example.com/elsewhere.jpg"), None).await;
        del(user.id).await.assert_success_message("Profile picture deleted successfully");
        assert_eq!(fake.requests_with("DELETE").len(), before);

        // A user without a picture.
        del(create_user(&db.pool).await.id).await.assert_success_message("Profile picture deleted successfully");

        // Blob deletion failures are only logged.
        fake.set_fail_delete(Some(|_| true));
        let user = create_user(&db.pool).await;
        set_picture(&db.pool, user.id, Some(&format!("{DEV_PREFIX}8/pic.jpg")), None).await;
        del(user.id).await.assert_success_message("Profile picture deleted successfully");
        fake.set_fail_delete(None);

        // Unknown user.
        del(999_999).await.assert_error(404, "USER_NOT_FOUND", "User not found");

        // The profile update fails.
        let user = create_user(&db.pool).await;
        let fault = fail_on(&db.pool, "UPDATE", "users").await;
        del(user.id).await.assert_error(500, "UPDATE_FAILED", "Failed to update profile");
        fault.clear().await;

        // The user lookup fails.
        let broken = db.broken().await;
        let failing = app.blob_router(blob_handler(&broken, Some(fake.store(false))));
        let res = call(&failing, "DELETE", "/api/profile/picture", Some(&app.token(user.id)), None).await;
        res.assert_error(404, "USER_NOT_FOUND", "User not found");
        db.finish().await;
    });
}
