//! `ActivityPhotoRepository` against PostgreSQL (port of
//! `internal/repository/activity_photo_repository_test.go`). Runs only when
//! `TEST_DATABASE_URL` points at a server whose role may create databases; every test gets its
//! own database.

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use gt_core::db;
use gt_core::gojson;
use gt_core::models::ActivityPhoto;
use gt_photos::repository::{ActivityPhotoRepository, NewActivityPhoto};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};

const TILE: &str = "custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

fn day() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 3, 9).unwrap()
}

fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 3, 9, 8, 0, 0).unwrap()
}

fn minutes(n: i64) -> DateTime<Utc> {
    t0() + Duration::minutes(n)
}

/// How Go stored `time.Now()` in a `TIMESTAMP` column: the UTC wall clock.
fn utc_wall_clock(at: DateTime<Utc>) -> chrono::NaiveDateTime {
    at.naive_utc()
}

struct TestDb {
    admin_url: String,
    name: String,
    pool: PgPool,
}

impl TestDb {
    /// A fresh migrated database, or `None` (test skipped) without `TEST_DATABASE_URL`.
    async fn new(test: &str) -> Option<Self> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_photos_{test}_{}", std::process::id());
        let mut admin = PgConnection::connect(&admin_url).await.expect("connect admin");
        sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
        let mut url = url::Url::parse(&admin_url).unwrap();
        url.set_path(&format!("/{name}"));
        let pool = PgPoolOptions::new().max_connections(4).connect(url.as_str()).await.expect("connect test db");
        db::migrate(&pool).await.expect("migrate");
        Some(Self { admin_url, name, pool })
    }

    fn repo(&self) -> ActivityPhotoRepository {
        ActivityPhotoRepository::new(self.pool.clone())
    }

    async fn drop(self) {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.admin_url).await.unwrap();
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name)).execute(&mut admin).await;
    }

    async fn user(&self, username: &str, with_avatar: bool) -> i64 {
        let (pic, thumb) = if with_avatar {
            (
                Some(format!("https://cdn.example.com/{username}.jpg")),
                Some(format!("https://cdn.example.com/{username}_t.jpg")),
            )
        } else {
            (None, None)
        };
        sqlx::query_scalar(
            "INSERT INTO users (email, username, password_hash, profile_pic, profile_pic_thumb) \
             VALUES ($1, $2, 'x', $3, $4) RETURNING id",
        )
        .bind(format!("{username}@example.com"))
        .bind(username)
        .bind(pic)
        .bind(thumb)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn follow(&self, follower: i64, followee: i64, state: &str) {
        sqlx::query(
            "INSERT INTO follow_edges_by_follower (follower_id, followee_id, state, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $4)",
        )
        .bind(follower)
        .bind(followee)
        .bind(state)
        .bind(t0())
        .execute(&self.pool)
        .await
        .unwrap();
    }

    async fn photo(&self, user_id: i64, activity: &str, date: NaiveDate, created_at: DateTime<Utc>) -> ActivityPhoto {
        let mut photo = self
            .repo()
            .create(&NewActivityPhoto {
                user_id,
                activity_name: activity.into(),
                photo_date: date,
                photo_url: format!("https://blob.example.com/{user_id}/{activity}/{date}.jpg"),
                thumbnail_url: format!("https://blob.example.com/{user_id}/{activity}/{date}_thumb.jpg"),
                activity_icon: None,
                activity_color: None,
                activity_label: None,
            })
            .await
            .unwrap();
        sqlx::query("UPDATE activity_photos SET created_at = $1 WHERE id = $2")
            .bind(created_at)
            .bind(photo.id)
            .execute(&self.pool)
            .await
            .unwrap();
        photo.created_at = created_at;
        photo
    }

    async fn set_viewed_at(&self, viewer: i64, photo: i64, at: DateTime<Utc>) {
        sqlx::query("UPDATE story_views SET viewed_at = $1 WHERE viewer_id = $2 AND photo_id = $3")
            .bind(at)
            .bind(viewer)
            .bind(photo)
            .execute(&self.pool)
            .await
            .unwrap();
    }

    async fn set_liked_at(&self, liker: i64, photo: i64, at: DateTime<Utc>) {
        sqlx::query("UPDATE story_likes SET liked_at = $1 WHERE liker_id = $2 AND photo_id = $3")
            .bind(utc_wall_clock(at))
            .bind(liker)
            .bind(photo)
            .execute(&self.pool)
            .await
            .unwrap();
    }
}

fn ids(photos: &[ActivityPhoto]) -> Vec<i64> {
    photos.iter().map(|p| p.id).collect()
}

#[tokio::test]
async fn create_and_get_by_id() {
    let Some(t) = TestDb::new("create").await else { return };
    let repo = t.repo();
    let user = t.user("creator", false).await;
    let new = NewActivityPhoto {
        user_id: user,
        activity_name: TILE.into(),
        photo_date: day(),
        photo_url: "https://blob.example.com/p.jpg".into(),
        thumbnail_url: "https://blob.example.com/p_thumb.jpg".into(),
        activity_icon: Some("flower".into()),
        activity_color: Some("#00ff00".into()),
        activity_label: Some("Yoga 🧘".into()),
    };

    let created = repo.create(&new).await.unwrap();
    assert!(created.id > 0);
    assert!((Utc::now() - created.created_at).num_seconds().abs() < 60);

    let got = repo.get_by_id(created.id).await.unwrap().expect("photo exists");
    assert_eq!(got.photo_url, new.photo_url);
    assert_eq!(got.thumbnail_url, new.thumbnail_url);
    assert_eq!(got.photo_date, day());
    assert_eq!(gojson::format_go_date(&got.photo_date), "2026-03-09T00:00:00Z");
    assert_eq!(got.activity_icon.as_deref(), Some("flower"));
    assert_eq!(got.activity_color.as_deref(), Some("#00ff00"));
    assert_eq!(got.activity_label.as_deref(), Some("Yoga 🧘"));
    assert_eq!(
        got.created_at.timestamp_micros(),
        created.created_at.timestamp_micros(),
        "the stored time is the returned one (at database precision)"
    );

    assert!(repo.create(&new).await.is_err(), "one photo per activity per day");
    assert_eq!(repo.get_by_id(9999).await.unwrap(), None);
    t.drop().await;
}

#[tokio::test]
async fn by_user_and_date() {
    let Some(t) = TestDb::new("by_date").await else { return };
    let repo = t.repo();
    let (user, other) = (t.user("u1", false).await, t.user("u2", false).await);
    let (mar8, mar10, mar12) = (day() - Duration::days(1), day() + Duration::days(1), day() + Duration::days(3));
    let workout = t.photo(user, "workout", day(), t0()).await;
    let study = t.photo(user, "study", day(), t0()).await;
    let earlier = t.photo(user, "sleep", mar8, t0()).await;
    let later = t.photo(user, "eating", mar10, t0()).await;
    t.photo(user, "reels", mar12, t0()).await;
    t.photo(other, "study", day(), t0()).await;

    let got = repo.get_by_user_and_date(user, day()).await.unwrap();
    assert_eq!(ids(&got), vec![study.id, workout.id], "ordered by activity name");

    let got = repo.get_by_user_and_date_range(user, mar8, mar10).await.unwrap();
    assert_eq!(
        ids(&got),
        vec![later.id, study.id, workout.id, earlier.id],
        "inclusive range, newest day first then by activity name"
    );

    let got = repo.get_by_user_and_date(user, day() + Duration::days(30)).await.unwrap();
    assert!(got.is_empty());
    t.drop().await;
}

#[tokio::test]
async fn activity_name_operations() {
    let Some(t) = TestDb::new("activity_name").await else { return };
    let repo = t.repo();
    let (user, other) = (t.user("u1", false).await, t.user("u2", false).await);
    let older = t.photo(user, TILE, day() - Duration::days(2), t0()).await;
    let newer = t.photo(user, TILE, day(), t0()).await;
    let unrelated = t.photo(user, "study", day(), t0()).await;
    let others_tile = t.photo(other, TILE, day(), t0()).await;

    let got = repo.get_by_activity_name(user, TILE).await.unwrap();
    assert_eq!(ids(&got), vec![newer.id, older.id], "newest first, own photos only");

    repo.update_label_by_activity_name(user, TILE, "Meditation").await.unwrap();
    for p in repo.get_by_activity_name(user, TILE).await.unwrap() {
        assert_eq!(p.activity_label.as_deref(), Some("Meditation"));
    }
    let still_unlabelled = repo.get_by_id(others_tile.id).await.unwrap().unwrap();
    assert_eq!(still_unlabelled.activity_label, None, "other users' photos keep their label");

    repo.delete_by_user_and_activity(user, TILE).await.unwrap();
    assert!(repo.get_by_activity_name(user, TILE).await.unwrap().is_empty());
    for id in [unrelated.id, others_tile.id] {
        assert!(repo.get_by_id(id).await.unwrap().is_some(), "photo {id} survives");
    }
    t.drop().await;
}

#[tokio::test]
async fn exists_and_get_existing() {
    let Some(t) = TestDb::new("exists").await else { return };
    let repo = t.repo();
    let user = t.user("u1", false).await;
    let photo = t.photo(user, "study", day(), t0()).await;

    assert!(repo.exists(user, "study", day()).await.unwrap());
    assert_eq!(repo.get_existing(user, "study", day()).await.unwrap().map(|p| p.id), Some(photo.id));

    for (activity, date) in [("sleep", day()), ("study", day() + Duration::days(1))] {
        assert!(!repo.exists(user, activity, date).await.unwrap());
        assert_eq!(repo.get_existing(user, activity, date).await.unwrap(), None);
    }
    t.drop().await;
}

#[tokio::test]
async fn delete_removes_views_and_likes() {
    let Some(t) = TestDb::new("delete").await else { return };
    let repo = t.repo();
    let (owner, viewer) = (t.user("owner", false).await, t.user("viewer", false).await);
    let photo = t.photo(owner, "study", day(), t0()).await;
    let kept = t.photo(owner, "sleep", day(), t0()).await;
    repo.record_view(viewer, photo.id).await.unwrap();
    repo.like_photo(viewer, photo.id).await.unwrap();

    repo.delete(photo.id).await.unwrap();

    assert_eq!(repo.get_by_id(photo.id).await.unwrap(), None);
    assert!(repo.get_by_id(kept.id).await.unwrap().is_some());
    assert_eq!(repo.get_view_count(photo.id).await.unwrap(), 0, "views cascade");
    assert_eq!(repo.get_photo_like_count(photo.id).await.unwrap(), 0, "likes cascade");
    t.drop().await;
}

/// The viewer follows `a` and `b` (ACTIVE), has a pending request to `c` and does not follow
/// `d`. `a` uploaded two photos on the day, `b` one; others upload too.
struct Stories {
    viewer: i64,
    a: i64,
    b: i64,
    d: i64,
    a1: ActivityPhoto,
    a2: ActivityPhoto,
    b1: ActivityPhoto,
}

async fn stories(t: &TestDb) -> Stories {
    let viewer = t.user("viewer", false).await;
    let a = t.user("alice", true).await;
    let b = t.user("bob", false).await;
    let c = t.user("carol", false).await;
    let d = t.user("dave", false).await;
    t.follow(viewer, a, "ACTIVE").await;
    t.follow(viewer, b, "ACTIVE").await;
    t.follow(viewer, c, "PENDING").await;
    let a1 = t.photo(a, "study", day(), minutes(1)).await;
    let b1 = t.photo(b, "workout", day(), minutes(2)).await;
    let a2 = t.photo(a, "sleep", day(), minutes(3)).await;
    t.photo(c, "study", day(), minutes(4)).await;
    t.photo(d, "study", day(), minutes(5)).await;
    t.photo(a, "reels", day() - Duration::days(1), minutes(6)).await;
    t.photo(viewer, "study", day(), minutes(7)).await;
    Stories { viewer, a, b, d, a1, a2, b1 }
}

#[tokio::test]
async fn following_photos() {
    let Some(t) = TestDb::new("following").await else { return };
    let repo = t.repo();
    let f = stories(&t).await;

    let got = repo.get_following_photos(f.viewer, day(), 10, 0).await.unwrap().unwrap();
    assert_eq!(ids(&got), vec![f.a2.id, f.b1.id, f.a1.id], "only accepted follows on that day, newest upload first");
    assert_eq!(got[0].photo_url, f.a2.photo_url);

    let got = repo.get_following_photos(f.viewer, day(), 1, 1).await.unwrap().unwrap();
    assert_eq!(ids(&got), vec![f.b1.id], "limit and offset");

    assert_eq!(repo.get_following_photos(f.d, day(), 10, 0).await.unwrap(), None, "nil slice -> null");
    t.drop().await;
}

#[tokio::test]
async fn following_photos_grouped() {
    let Some(t) = TestDb::new("grouped").await else { return };
    let repo = t.repo();
    let f = stories(&t).await;
    repo.record_view(f.viewer, f.a1.id).await.unwrap();
    repo.record_view(f.viewer, f.b1.id).await.unwrap();

    let groups = repo.get_following_photos_grouped(f.viewer, day(), 10).await.unwrap().unwrap();
    assert_eq!(groups.len(), 2);
    let (first, second) = (&groups[0], &groups[1]);
    assert_eq!(first.user_id, f.a, "users with the most recent upload come first");
    assert_eq!(first.username, "alice");
    assert_eq!(first.profile_pic.as_deref(), Some("https://cdn.example.com/alice.jpg"));
    assert_eq!(first.profile_pic_thumb.as_deref(), Some("https://cdn.example.com/alice_t.jpg"));
    let photos = first.photos.as_ref().unwrap();
    assert_eq!(photos.len(), 2);
    assert_eq!(photos[0].photo.id, f.a1.id, "oldest photo first within a story");
    assert!(photos[0].viewed);
    assert_eq!(photos[1].photo.id, f.a2.id);
    assert!(!photos[1].viewed);
    assert!(first.has_unseen);

    assert_eq!(second.user_id, f.b);
    assert_eq!(second.profile_pic, None);
    assert_eq!(second.photos.as_ref().unwrap().len(), 1);
    assert!(second.photos.as_ref().unwrap()[0].viewed);
    assert!(!second.has_unseen, "every photo was viewed");

    let json = gojson::to_string(second).unwrap();
    assert!(
        json.starts_with(&format!(r#"{{"user_id":{},"username":"bob","photos":[{{"id":{}"#, f.b, f.b1.id)),
        "{json}"
    );
    let created_at = gojson::format_go_time(&minutes(2));
    assert!(json.ends_with(&format!(r#""created_at":"{created_at}","viewed":true}}],"has_unseen":false}}"#)), "{json}");

    let groups = repo.get_following_photos_grouped(f.viewer, day(), 1).await.unwrap().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].user_id, f.a);

    assert_eq!(repo.get_following_photos_grouped(f.viewer, day() + Duration::days(5), 10).await.unwrap(), None);
    t.drop().await;
}

#[tokio::test]
async fn views() {
    let Some(t) = TestDb::new("views").await else { return };
    let repo = t.repo();
    let owner = t.user("owner", false).await;
    let (alice, bob, carol) = (t.user("alice", true).await, t.user("bob", false).await, t.user("carol", false).await);
    let photo = t.photo(owner, "study", day(), t0()).await;
    let other = t.photo(owner, "sleep", day(), t0()).await;

    for u in [alice, bob, carol] {
        repo.record_view(u, photo.id).await.unwrap();
    }
    repo.record_view(alice, photo.id).await.expect("repeat views are ignored");
    repo.record_view(bob, other.id).await.unwrap();
    t.set_viewed_at(alice, photo.id, minutes(3)).await;
    t.set_viewed_at(bob, photo.id, minutes(1)).await;
    t.set_viewed_at(carol, photo.id, minutes(2)).await;

    assert!(repo.has_viewed(alice, photo.id).await.unwrap());
    assert!(!repo.has_viewed(carol, other.id).await.unwrap());
    assert_eq!(repo.get_view_count(photo.id).await.unwrap(), 3, "each viewer counts once");

    let (viewers, total) = repo.get_viewers(photo.id, 2, 0).await.unwrap();
    let viewers = viewers.unwrap();
    assert_eq!(total, 3);
    assert_eq!(viewers.len(), 2);
    assert_eq!(viewers[0].user_id, alice);
    assert_eq!(viewers[0].username, "alice");
    assert_eq!(viewers[0].profile_pic.as_deref(), Some("https://cdn.example.com/alice.jpg"));
    assert_eq!(viewers[0].profile_pic_thumb.as_deref(), Some("https://cdn.example.com/alice_t.jpg"));
    assert_eq!(viewers[0].viewed_at, minutes(3), "most recent first");
    assert_eq!(viewers[1].user_id, carol);

    let (viewers, total) = repo.get_viewers(photo.id, 2, 2).await.unwrap();
    assert_eq!(total, 3);
    assert_eq!(viewers.unwrap().iter().map(|v| v.user_id).collect::<Vec<_>>(), vec![bob]);
    let (viewers, total) = repo.get_viewers(photo.id, 2, 10).await.unwrap();
    assert_eq!((viewers, total), (None, 3), "an empty page is a nil slice");

    let mut seen = repo.get_viewed_photo_ids(bob, &[photo.id, other.id, 9999]).await.unwrap();
    seen.sort_unstable();
    let mut want = vec![photo.id, other.id];
    want.sort_unstable();
    assert_eq!(seen, want);
    assert!(repo.get_viewed_photo_ids(carol, &[other.id]).await.unwrap().is_empty());
    assert!(repo.get_viewed_photo_ids(carol, &[]).await.unwrap().is_empty());
    t.drop().await;
}

#[tokio::test]
async fn likes() {
    let Some(t) = TestDb::new("likes").await else { return };
    let repo = t.repo();
    let owner = t.user("owner", false).await;
    let (alice, bob) = (t.user("alice", true).await, t.user("bob", false).await);
    let photo = t.photo(owner, "study", day(), t0()).await;
    let other = t.photo(owner, "sleep", day(), t0()).await;

    repo.like_photo(alice, photo.id).await.unwrap();
    repo.like_photo(alice, photo.id).await.expect("liking twice is not an error");
    repo.like_photo(bob, photo.id).await.unwrap();
    repo.like_photo(bob, other.id).await.unwrap();
    t.set_liked_at(alice, photo.id, minutes(1)).await;
    t.set_liked_at(bob, photo.id, minutes(2)).await;

    assert_eq!(repo.get_photo_like_count(photo.id).await.unwrap(), 2);
    assert!(repo.has_liked_photo(alice, photo.id).await.unwrap());
    assert!(!repo.has_liked_photo(alice, other.id).await.unwrap());

    let (likers, total) = repo.get_photo_likers(photo.id, 10, 0).await.unwrap();
    let likers = likers.unwrap();
    assert_eq!(total, 2);
    assert_eq!(likers.len(), 2);
    assert_eq!(likers[0].user_id, bob, "most recent first");
    assert_eq!(likers[1].user_id, alice);
    assert_eq!(likers[1].username, "alice");
    assert_eq!(likers[1].profile_pic.as_deref(), Some("https://cdn.example.com/alice.jpg"));
    assert_eq!(likers[1].liked_at, utc_wall_clock(minutes(1)).and_utc(), "timestamp without time zone read as UTC");

    let (likers, total) = repo.get_photo_likers(photo.id, 1, 1).await.unwrap();
    assert_eq!(total, 2);
    assert_eq!(likers.unwrap().iter().map(|l| l.user_id).collect::<Vec<_>>(), vec![alice]);

    let mut liked = repo.get_liked_photo_ids(bob, &[photo.id, other.id]).await.unwrap();
    liked.sort_unstable();
    let mut want = vec![photo.id, other.id];
    want.sort_unstable();
    assert_eq!(liked, want);
    assert!(repo.get_liked_photo_ids(alice, &[]).await.unwrap().is_empty());

    repo.unlike_photo(alice, photo.id).await.unwrap();
    repo.unlike_photo(alice, photo.id).await.expect("unliking twice is not an error");
    assert!(!repo.has_liked_photo(alice, photo.id).await.unwrap());
    assert_eq!(repo.get_photo_like_count(photo.id).await.unwrap(), 1);

    assert!(repo.like_photo(alice, 9999).await.is_err(), "only duplicate likes are swallowed");
    t.drop().await;
}

#[tokio::test]
async fn interactions() {
    let Some(t) = TestDb::new("interactions").await else { return };
    let repo = t.repo();
    let owner = t.user("owner", false).await;
    let (viewer, liker, both) =
        (t.user("viewer", false).await, t.user("liker", true).await, t.user("both", false).await);
    let photo = t.photo(owner, "study", day(), t0()).await;
    let other = t.photo(owner, "sleep", day(), t0()).await;

    repo.record_view(viewer, photo.id).await.unwrap();
    t.set_viewed_at(viewer, photo.id, minutes(1)).await;
    repo.like_photo(liker, photo.id).await.unwrap();
    t.set_liked_at(liker, photo.id, minutes(3)).await;
    repo.record_view(both, photo.id).await.unwrap();
    t.set_viewed_at(both, photo.id, minutes(2)).await;
    repo.like_photo(both, photo.id).await.unwrap();
    t.set_liked_at(both, photo.id, minutes(4)).await;
    repo.record_view(owner, other.id).await.unwrap();

    let (got, total) = repo.get_photo_interactions(photo.id, 10, 0).await.unwrap();
    let got = got.unwrap();
    assert_eq!(total, 3, "distinct users who viewed or liked");
    assert_eq!(got.len(), 3);
    assert_eq!(got[0].user_id, both, "ordered by latest interaction");
    assert_eq!(got[0].interaction_type, "both");
    assert_eq!(got[0].viewed_at, minutes(2));
    assert_eq!(got[0].liked_at, utc_wall_clock(minutes(4)).and_utc());

    assert_eq!(got[1].user_id, liker);
    assert_eq!(got[1].interaction_type, "like");
    assert_eq!(got[1].username, "liker");
    assert_eq!(got[1].profile_pic.as_deref(), Some("https://cdn.example.com/liker.jpg"));
    assert!(gojson::is_go_zero_time(&got[1].viewed_at), "never viewed");

    assert_eq!(got[2].user_id, viewer);
    assert_eq!(got[2].interaction_type, "view");
    assert!(gojson::is_go_zero_time(&got[2].liked_at), "never liked");
    assert!(gojson::to_string(&got[2]).unwrap().ends_with(r#""liked_at":"0001-01-01T00:00:00Z"}"#));

    let (got, total) = repo.get_photo_interactions(photo.id, 1, 1).await.unwrap();
    assert_eq!(total, 3);
    assert_eq!(got.unwrap().iter().map(|i| i.user_id).collect::<Vec<_>>(), vec![liker]);
    assert_eq!(repo.get_photo_interactions(other.id + 100, 10, 0).await.unwrap(), (None, 0));
    t.drop().await;
}

#[tokio::test]
async fn database_errors_are_returned() {
    // Nothing listens on port 9: every query fails quickly.
    let pool = PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(500))
        .connect_lazy("postgres://postgres:postgres@127.0.0.1:9/none")
        .unwrap();
    let repo = ActivityPhotoRepository::new(pool);

    assert!(repo.get_viewed_photo_ids(1, &[]).await.unwrap().is_empty(), "no query for an empty list");
    assert!(repo.get_liked_photo_ids(1, &[]).await.unwrap().is_empty());

    let new = NewActivityPhoto {
        user_id: 1,
        activity_name: "study".into(),
        photo_date: day(),
        photo_url: "u".into(),
        thumbnail_url: "t".into(),
        activity_icon: None,
        activity_color: None,
        activity_label: None,
    };
    assert!(repo.create(&new).await.is_err());
    assert!(repo.get_by_id(1).await.is_err());
    assert!(repo.get_by_user_and_date(1, day()).await.is_err());
    assert!(repo.get_by_user_and_date_range(1, day(), day()).await.is_err());
    assert!(repo.update_label_by_activity_name(1, "study", "x").await.is_err());
    assert!(repo.get_by_activity_name(1, "study").await.is_err());
    assert!(repo.get_following_photos(1, day(), 10, 0).await.is_err());
    assert!(repo.get_following_photos_grouped(1, day(), 10).await.is_err());
    assert!(repo.delete(1).await.is_err());
    assert!(repo.delete_by_user_and_activity(1, "study").await.is_err());
    assert!(repo.exists(1, "study", day()).await.is_err());
    assert!(repo.get_existing(1, "study", day()).await.is_err());
    assert!(repo.record_view(1, 1).await.is_err());
    assert!(repo.has_viewed(1, 1).await.is_err());
    assert!(repo.get_viewers(1, 10, 0).await.is_err());
    assert!(repo.get_view_count(1).await.is_err());
    assert!(repo.get_viewed_photo_ids(1, &[1]).await.is_err());
    assert!(repo.like_photo(1, 1).await.is_err());
    assert!(repo.unlike_photo(1, 1).await.is_err());
    assert!(repo.has_liked_photo(1, 1).await.is_err());
    assert!(repo.get_photo_likers(1, 10, 0).await.is_err());
    assert!(repo.get_photo_like_count(1).await.is_err());
    assert!(repo.get_liked_photo_ids(1, &[1]).await.is_err());
    assert!(repo.get_photo_interactions(1, 10, 0).await.is_err());
}
