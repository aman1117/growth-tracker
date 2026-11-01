//! The Redis likes cache behind `POST /api/get-likes` (Go: `handlers/like.go`).
//!
//! Every test runs on one shared runtime because the Redis connection is a process-wide global
//! whose background task must outlive individual tests. The Redis server is shared, so the tests
//! use user ids nobody else uses and delete only the keys they touch.

mod common;

use std::future::Future;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::OnceLock;

use common::{create_user, send, Stack, TestDb};
use gt_core::gojson;
use gt_core::models::User;
use redis::AsyncCommands;
use serde_json::{json, Value};
use tokio::runtime::Runtime;
use tokio::sync::OnceCell;

const DATE: &str = "2026-03-09";

fn rt() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap())
}

fn run<F: Future>(future: F) -> F::Output {
    rt().block_on(future)
}

/// Connects the global Redis handle once; `false` (tests skip) when Redis is unavailable.
async fn redis_ready() -> bool {
    static READY: OnceCell<bool> = OnceCell::const_new();
    *READY
        .get_or_init(|| async {
            let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:56379".into());
            match gt_core::redis::init(&url).await {
                Ok(()) => gt_core::redis::is_available(),
                Err(err) => {
                    eprintln!("Redis unavailable ({err}); likes cache tests are skipped");
                    false
                }
            }
        })
        .await
}

/// First user id of a test: unique per process and test, far from ids used elsewhere.
fn first_user_id() -> i64 {
    static NEXT: AtomicI64 = AtomicI64::new(0);
    7_800_000_000_000 + i64::from(std::process::id()) * 10_000 + NEXT.fetch_add(100, Ordering::Relaxed)
}

fn redis_conn() -> redis::aio::ConnectionManager {
    gt_core::redis::conn().expect("redis connected")
}

async fn cached(owner: &User) -> Option<String> {
    redis_conn().get(gt_core::redis::likes_cache_key(owner.id, DATE)).await.unwrap()
}

async fn put_cached(owner: &User, value: &str) {
    let _: () = redis_conn().set(gt_core::redis::likes_cache_key(owner.id, DATE), value).await.unwrap();
}

async fn drop_cached(owner: &User) {
    let _: () = redis_conn().del(gt_core::redis::likes_cache_key(owner.id, DATE)).await.unwrap();
}

/// Database and users `owner`, `liker`, `viewer` with unique ids; `None` without a database or Redis.
async fn setup(name: &str) -> Option<(TestDb, Stack, User, User, User)> {
    if !redis_ready().await {
        return None;
    }
    let db = TestDb::new(name).await?;
    db.start_user_ids_at(first_user_id()).await;
    let stack = Stack::new(&db.pool);
    let owner = create_user(&stack, "owner", false).await;
    let liker = create_user(&stack, "liker", false).await;
    let viewer = create_user(&stack, "viewer", false).await;
    drop_cached(&owner).await;
    Some((db, stack, owner, liker, viewer))
}

fn day_body() -> String {
    json!({"username": "owner", "date": DATE}).to_string()
}

async fn get_likes(stack: &Stack, caller: &User) -> (u16, String) {
    send(&stack.router(), stack, caller, "POST", "/api/get-likes", Some(&day_body())).await
}

/// The JSON Go cached for the given likers: `[{"id":..,"username":..,"is_verified":false,"liked_at":..}]`.
async fn likers_json(db: &TestDb, likers: &[&User]) -> String {
    let mut entries = Vec::new();
    for liker in likers {
        let at: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT created_at FROM likes WHERE liker_id = $1")
            .bind(liker.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        entries.push(format!(
            r#"{{"id":{},"username":"{}","is_verified":false,"liked_at":"{}"}}"#,
            liker.id,
            liker.username,
            gojson::format_rfc3339_local(&at)
        ));
    }
    format!("[{}]", entries.join(","))
}

fn likes_response(data: &str, user_has_liked: bool) -> String {
    let count = serde_json::from_str::<Value>(data).unwrap().as_array().map_or(0, Vec::len);
    format!(r#"{{"success":true,"data":{data},"count":{count},"user_has_liked":{user_has_liked}}}"#)
}

#[test]
fn get_likes_fills_and_serves_the_cache() {
    run(async {
        let Some((db, stack, owner, liker, viewer)) = setup("cache_fill").await else { return };
        let router = stack.router();
        send(&router, &stack, &liker, "POST", "/api/like-day", Some(&day_body())).await;
        assert_eq!(cached(&owner).await, None, "liking leaves no cache entry");

        let data = likers_json(&db, &[&liker]).await;
        assert_eq!(get_likes(&stack, &viewer).await, (200, likes_response(&data, false)));
        assert_eq!(cached(&owner).await.as_deref(), Some(data.as_str()), "the likers are cached as Go marshalled them");
        let ttl: i64 = redis_conn().ttl(gt_core::redis::likes_cache_key(owner.id, DATE)).await.unwrap();
        assert!((4 * 3600 - 60..=4 * 3600).contains(&ttl), "cached for 4 hours, got {ttl}s");

        // Served from the cache: a like removed behind the cache's back still shows, while
        // `user_has_liked` is always read from the database.
        sqlx::query("DELETE FROM likes").execute(&db.pool).await.unwrap();
        assert_eq!(get_likes(&stack, &liker).await, (200, likes_response(&data, false)));

        // An empty cached list is a hit; `null` is a miss.
        put_cached(&owner, "[]").await;
        assert_eq!(get_likes(&stack, &viewer).await, (200, likes_response("[]", false)));
        put_cached(&owner, &data).await;
        put_cached(&owner, "null").await;
        assert_eq!(get_likes(&stack, &viewer).await, (200, likes_response("[]", false)));
        assert_eq!(cached(&owner).await.as_deref(), Some("[]"), "the miss refreshed the cache");

        drop_cached(&owner).await;
        db.finish().await;
    });
}

#[test]
fn like_and_unlike_invalidate_the_cache() {
    run(async {
        let Some((db, stack, owner, liker, viewer)) = setup("cache_invalidate").await else { return };
        let router = stack.router();
        send(&router, &stack, &liker, "POST", "/api/like-day", Some(&day_body())).await;
        get_likes(&stack, &viewer).await;
        assert!(cached(&owner).await.is_some());

        send(&router, &stack, &viewer, "POST", "/api/like-day", Some(&day_body())).await;
        assert_eq!(cached(&owner).await, None, "a new like drops the cached likers");
        // Make the newest-first order independent of clock resolution.
        sqlx::query("UPDATE likes SET created_at = created_at + interval '1 minute' WHERE liker_id = $1")
            .bind(viewer.id)
            .execute(&db.pool)
            .await
            .unwrap();
        let data = likers_json(&db, &[&viewer, &liker]).await;
        assert_eq!(get_likes(&stack, &viewer).await, (200, likes_response(&data, true)));
        assert_eq!(cached(&owner).await.as_deref(), Some(data.as_str()));

        // Re-liking (already liked) changes nothing and keeps the cache.
        send(&router, &stack, &viewer, "POST", "/api/like-day", Some(&day_body())).await;
        assert!(cached(&owner).await.is_some(), "an existing like keeps the cache");

        send(&router, &stack, &viewer, "POST", "/api/unlike-day", Some(&day_body())).await;
        assert_eq!(cached(&owner).await, None, "unliking drops the cached likers");
        let data = likers_json(&db, &[&liker]).await;
        assert_eq!(get_likes(&stack, &viewer).await, (200, likes_response(&data, false)));

        // Unliking without a like leaves the cache alone.
        send(&router, &stack, &viewer, "POST", "/api/unlike-day", Some(&day_body())).await;
        assert_eq!(cached(&owner).await.as_deref(), Some(data.as_str()));

        drop_cached(&owner).await;
        db.finish().await;
    });
}

#[test]
fn unreadable_cache_entries_fall_back_to_the_database() {
    run(async {
        let Some((db, stack, owner, liker, viewer)) = setup("cache_unreadable").await else { return };
        send(&stack.router(), &stack, &liker, "POST", "/api/like-day", Some(&day_body())).await;
        let data = likers_json(&db, &[&liker]).await;

        // Not JSON: read from the database and the entry is replaced.
        put_cached(&owner, "{not json").await;
        assert_eq!(get_likes(&stack, &viewer).await, (200, likes_response(&data, false)));
        assert_eq!(cached(&owner).await.as_deref(), Some(data.as_str()));

        // A read error (a hash at the key): read from the database; SET then replaces the key.
        drop_cached(&owner).await;
        let _: () = redis_conn().hset(gt_core::redis::likes_cache_key(owner.id, DATE), "f", "v").await.unwrap();
        assert_eq!(get_likes(&stack, &viewer).await, (200, likes_response(&data, false)));
        assert_eq!(cached(&owner).await.as_deref(), Some(data.as_str()));

        drop_cached(&owner).await;
        db.finish().await;
    });
}
