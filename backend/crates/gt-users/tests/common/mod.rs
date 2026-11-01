//! Shared fixtures for the database tests. They run only when `TEST_DATABASE_URL` points at a
//! PostgreSQL server whose role may create databases; each test uses its own database.

#![allow(dead_code)]

use chrono::{DateTime, Utc};
use gt_core::models::User;
use gt_users::repository::UserRepository;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};

pub struct TestDb {
    pub pool: PgPool,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// A freshly migrated database named `gt_users_<test>`, or `None` (skip) without
    /// `TEST_DATABASE_URL`.
    pub async fn new(test: &str) -> Option<TestDb> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_users_{test}");
        let mut admin = PgConnection::connect(&admin_url).await.expect("connect admin");
        sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
        let mut url = url::Url::parse(&admin_url).unwrap();
        url.set_path(&format!("/{name}"));
        let pool = PgPoolOptions::new().max_connections(8).connect(url.as_str()).await.expect("connect test db");
        gt_core::db::migrate(&pool).await.expect("migrate");
        Some(TestDb { pool, admin_url, name })
    }

    pub async fn finish(self) {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.admin_url).await.unwrap();
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name)).execute(&mut admin).await;
    }
}

/// Registers `username` (`<username>@example.com`) through the repository and returns the row.
pub async fn create_user(repo: &UserRepository, username: &str) -> User {
    repo.create(&format!("{username}@example.com"), username, "hash").await.expect("create user");
    repo.find_by_username(username).await.unwrap().expect("user exists")
}

/// Creates a user with the given privacy flag.
pub async fn create_user_with(repo: &UserRepository, username: &str, is_private: bool) -> User {
    let user = create_user(repo, username).await;
    repo.update_privacy(user.id, is_private).await.unwrap();
    repo.find_by_id(user.id).await.unwrap().unwrap()
}

/// Sets `follower -> followee`'s `created_at` and `updated_at` in both edge tables.
pub async fn set_edge_times(pool: &PgPool, follower_id: i64, followee_id: i64, at: DateTime<Utc>) {
    for table in ["follow_edges_by_follower", "follow_edges_by_followee"] {
        sqlx::query(&format!(
            "UPDATE {table} SET created_at = $1, updated_at = $1 WHERE follower_id = $2 AND followee_id = $3"
        ))
        .bind(at)
        .bind(follower_id)
        .bind(followee_id)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// `(followers, following, pending)` straight from `follow_counters` (zeros when missing).
pub async fn counters(pool: &PgPool, user_id: i64) -> (i64, i64, i64) {
    sqlx::query_as::<_, (i64, i64, i64)>(
        "SELECT followers_count, following_count, pending_requests_count FROM follow_counters WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .unwrap()
    .unwrap_or((0, 0, 0))
}

/// `(state in by_follower, state in by_followee)` of an edge.
pub async fn edge_states(pool: &PgPool, follower_id: i64, followee_id: i64) -> (Option<String>, Option<String>) {
    let mut states = Vec::new();
    for table in ["follow_edges_by_follower", "follow_edges_by_followee"] {
        let state: Option<String> =
            sqlx::query_scalar(&format!("SELECT state FROM {table} WHERE follower_id = $1 AND followee_id = $2"))
                .bind(follower_id)
                .bind(followee_id)
                .fetch_optional(pool)
                .await
                .unwrap();
        states.push(state);
    }
    let followee = states.pop().unwrap();
    (states.pop().unwrap(), followee)
}
