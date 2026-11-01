//! Search suggestions and recent searches (port of `search_suggestions_test.go`). Query failures
//! with a broken database are covered in `without_redis.rs`.

mod common;

use chrono::{DateTime, Duration, Utc};
use common::{redis_del, redis_get, redis_ready, redis_set, redis_ttl, run, Env, TestUser, UserOpts};
use gt_accounts::dto::SearchSuggestionUser;
use serde_json::{json, Value};

/// A user with two recent searches and seven popular public users with distinct follower
/// counts. One recent search is also the most followed user overall.
struct Suggestions {
    env: Env,
    me: TestUser,
    /// Most recent first.
    recent: Vec<TestUser>,
    /// Most followers first.
    popular: Vec<TestUser>,
}

async fn set_followers(env: &Env, user: &TestUser, n: i64) {
    sqlx::query("UPDATE follow_counters SET followers_count = $1 WHERE user_id = $2")
        .bind(n)
        .bind(user.id)
        .execute(env.pool())
        .await
        .unwrap();
}

async fn add_recent_search(env: &Env, me: &TestUser, searched: &TestUser, at: DateTime<Utc>) {
    sqlx::query("INSERT INTO recent_searches (user_id, searched_user_id, searched_at) VALUES ($1, $2, $3)")
        .bind(me.id)
        .bind(searched.id)
        .bind(at)
        .execute(env.pool())
        .await
        .unwrap();
}

fn trending_key(user_id: i64) -> String {
    format!("trending:user:{user_id}")
}

impl Suggestions {
    async fn new(test: &str) -> Option<Self> {
        let env = Env::new(test).await?;
        let me = env.plain_user().await;
        let older = env.plain_user().await;
        let newer = env
            .user(UserOpts {
                picture: Some("http://pics.example/newer.jpg".into()),
                verified: true,
                ..UserOpts::default()
            })
            .await;
        set_followers(&env, &older, 50).await;
        let mut popular = Vec::new();
        for followers in [30, 20, 10, 5, 3, 2, 1] {
            let user = env.plain_user().await;
            set_followers(&env, &user, followers).await;
            popular.push(user);
        }
        let searched_at = Utc::now() - Duration::hours(1);
        add_recent_search(&env, &me, &older, searched_at).await;
        add_recent_search(&env, &me, &newer, searched_at + Duration::minutes(1)).await;
        // The handler caches trending users when Redis is up; start from a miss.
        if redis_ready().await {
            redis_del(&trending_key(me.id)).await;
        }
        Some(Self { env, me, recent: vec![newer, older], popular })
    }

    async fn suggestions(&self) -> Value {
        let resp = self.env.call("GET", "/api/search/suggestions", Some(&self.me), None).await;
        assert_eq!(resp.status, 200, "body: {}", resp.body);
        assert_eq!(resp.header("content-type"), "application/json");
        resp.json()
    }
}

fn ids(list: &Value) -> Vec<i64> {
    list.as_array().unwrap().iter().map(|u| u["id"].as_i64().unwrap()).collect()
}

fn ids_of<'a>(users: impl IntoIterator<Item = &'a TestUser>) -> Vec<i64> {
    users.into_iter().map(|u| u.id).collect()
}

#[test]
fn get_search_suggestions() {
    run(async {
        let Some(s) = Suggestions::new("suggest_get").await else { return };

        let got = s.suggestions().await;

        let newer = &s.recent[0];
        assert_eq!(
            got["recent"][0],
            json!({
                "id": newer.id, "username": newer.username, "profilePic": "http://pics.example/newer.jpg",
                "profilePicThumb": "http://pics.example/newer.jpg?thumb", "isVerified": true, "followersCount": 0,
            })
        );
        assert_eq!(ids(&got["recent"]), ids_of(&s.recent));
        // Six suggestions in total, most followed first, without users already in the recent list.
        assert_eq!(ids(&got["trending"]), ids_of(&s.popular[..4]));
        assert_eq!(got["trending"][0]["followersCount"], 30);
        assert_eq!(got["trending"][0].as_object().unwrap().len(), 4, "pictures are omitted when empty");
        s.env.finish().await;
    });
}

#[test]
fn five_recent_searches_leave_one_trending_slot() {
    run(async {
        let Some(s) = Suggestions::new("suggest_five_recent").await else { return };
        let base = Utc::now() - Duration::minutes(30);
        for (i, user) in s.popular[3..6].iter().enumerate() {
            add_recent_search(&s.env, &s.me, user, base + Duration::minutes(i as i64)).await;
        }

        let got = s.suggestions().await;

        let recent = [&s.popular[5], &s.popular[4], &s.popular[3], &s.recent[0], &s.recent[1]];
        assert_eq!(ids(&got["recent"]), ids_of(recent));
        assert_eq!(ids(&got["trending"]), vec![s.popular[0].id]);
        s.env.finish().await;
    });
}

#[test]
fn nothing_to_suggest() {
    run(async {
        let Some(env) = Env::new("suggest_nothing").await else { return };
        let me = env.plain_user().await;
        if redis_ready().await {
            redis_del(&trending_key(me.id)).await;
        }

        let resp = env.call("GET", "/api/search/suggestions", Some(&me), None).await;

        assert_eq!((resp.status, resp.body.as_str()), (200, r#"{"recent":[],"trending":[]}"#));
        env.finish().await;
    });
}

#[test]
fn trending_cache() {
    run(async {
        if !redis_ready().await {
            return;
        }
        let Some(s) = Suggestions::new("suggest_cache").await else { return };
        let key = trending_key(s.me.id);

        let first = s.suggestions().await;
        assert_eq!(ids(&first["trending"]), ids_of(&s.popular[..4]));
        let stored = redis_get(&key).await.expect("trending users are cached");
        assert!(stored.starts_with(&format!(r#"[{{"id":{},"username":"#, s.popular[0].id)), "{stored}");
        let stored: Value = serde_json::from_str(&stored).unwrap();
        // Seven rows were fetched (6 - 2 recent + 3 spare); the two recent searches were dropped.
        assert_eq!(ids(&stored), ids_of(&s.popular[..5]), "the deduplicated list is cached before truncation");
        assert!((295..=300).contains(&redis_ttl(&key).await), "cached for 5 minutes");

        // A cache hit drops users that are now recent searches.
        let cached = [
            SearchSuggestionUser { id: s.recent[1].id as u64, username: "stale".into(), ..Default::default() },
            SearchSuggestionUser { id: 4242, username: "cached_only".into(), ..Default::default() },
        ];
        redis_set(&key, &serde_json::to_string(&cached).unwrap()).await;
        let got = s.suggestions().await;
        assert_eq!(
            got["trending"],
            json!([{"id": 4242, "username": "cached_only", "isVerified": false, "followersCount": 0}])
        );
        assert_eq!(ids(&got["recent"]), ids_of(&s.recent));

        // An empty cached list is a hit; `null` is a miss.
        redis_set(&key, "[]").await;
        assert_eq!(s.suggestions().await["trending"], json!([]));
        redis_set(&key, "null").await;
        assert_eq!(ids(&s.suggestions().await["trending"]), ids_of(&s.popular[..4]));

        // A corrupt cache entry is replaced.
        redis_set(&key, "{not json").await;
        assert_eq!(ids(&s.suggestions().await["trending"]), ids_of(&s.popular[..4]));
        assert!(redis_get(&key).await.unwrap().contains(&s.popular[0].username));

        redis_del(&key).await;
        s.env.finish().await;
    });
}

#[test]
fn recent_searches_unavailable() {
    run(async {
        let Some(s) = Suggestions::new("suggest_recent_down").await else { return };
        sqlx::query("ALTER TABLE recent_searches RENAME TO recent_searches_down").execute(s.env.pool()).await.unwrap();

        let got = s.suggestions().await;

        assert_eq!(got["recent"], json!([]));
        // Verified users first, then by followers; recent searches are not filtered out when they
        // cannot be loaded.
        let want = [&s.recent[0], &s.recent[1], &s.popular[0], &s.popular[1], &s.popular[2], &s.popular[3]];
        assert_eq!(ids(&got["trending"]), ids_of(want));
        if redis_ready().await {
            redis_del(&trending_key(s.me.id)).await;
        }
        s.env.finish().await;
    });
}

#[test]
fn delete_recent_search() {
    run(async {
        let Some(s) = Suggestions::new("suggest_delete").await else { return };
        let other = s.env.plain_user().await;
        add_recent_search(&s.env, &other, &s.recent[0], Utc::now()).await;

        let uri = format!("/api/search/recent/{}", s.recent[0].id);
        s.env.call("DELETE", &uri, Some(&s.me), None).await.assert_success(200, "Recent search deleted");
        assert_eq!(ids(&s.suggestions().await["recent"]), vec![s.recent[1].id]);
        let others = s.env.count(&format!("SELECT COUNT(*) FROM recent_searches WHERE user_id = {}", other.id)).await;
        assert_eq!(others, 1, "other users keep their history");

        // Unknown entries are fine.
        let uri = format!("/api/search/recent/{}", s.me.id + 400);
        s.env.call("DELETE", &uri, Some(&s.me), None).await.assert_success(200, "Recent search deleted");
        s.env.finish().await;
    });
}

#[test]
fn clear_recent_searches() {
    run(async {
        let Some(s) = Suggestions::new("suggest_clear").await else { return };
        let other = s.env.plain_user().await;
        add_recent_search(&s.env, &other, &s.recent[0], Utc::now()).await;

        let resp = s.env.call("DELETE", "/api/search/recent", Some(&s.me), None).await;

        resp.assert_success(200, "Recent searches cleared");
        let count = |id: i64| s.env.count(&format!("SELECT COUNT(*) FROM recent_searches WHERE user_id = {id}"));
        assert_eq!(count(s.me.id).await, 0);
        assert_eq!(count(other.id).await, 1);
        s.env.finish().await;
    });
}
