//! Database integration checks. They run only when `TEST_DATABASE_URL` points at a PostgreSQL
//! server whose role may create databases, e.g.
//! `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable`.

use gt_core::db;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};

async fn fresh_database(admin_url: &str, name: &str) -> PgPool {
    let mut admin = PgConnection::connect(admin_url).await.expect("connect admin");
    sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
    let mut url = url::Url::parse(admin_url).unwrap();
    url.set_path(&format!("/{name}"));
    PgPoolOptions::new().max_connections(4).connect(url.as_str()).await.expect("connect test db")
}

async fn drop_database(admin_url: &str, name: &str) {
    let mut admin = PgConnection::connect(admin_url).await.unwrap();
    let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await;
}

#[tokio::test]
async fn schema_is_idempotent_and_session_is_utc() {
    let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL not set; skipping");
        return;
    };
    let name = "gt_core_schema_test";
    let pool = fresh_database(&admin_url, name).await;

    db::migrate(&pool).await.expect("first migration");
    db::migrate(&pool).await.expect("second migration is a no-op");

    let tables: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tables, 28);

    // The optional autocomplete steps ran too.
    let trigram: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM pg_extension WHERE extname = 'pg_trgm') \
              + (SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_users_username_trgm')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(trigram, 2);

    let tz: String = sqlx::query_scalar("SHOW TimeZone").fetch_one(&pool).await.unwrap();
    assert_eq!(tz, "UTC");

    // NUMERIC values decode through the casts used by the models.
    let hours: f32 = sqlx::query_scalar("SELECT 1.10::numeric(4,2)::float4").fetch_one(&pool).await.unwrap();
    assert_eq!(gt_core::gojson::format_go_float32(hours), "1.1");

    pool.close().await;
    drop_database(&admin_url, name).await;
}

/// `GT_EXISTING_DB_URL` may point at a database created by the Go backend (GORM AutoMigrate +
/// the migration scripts); applying the schema there must succeed without changes.
#[tokio::test]
async fn schema_applies_cleanly_to_go_created_database() {
    let Ok(url) = std::env::var("GT_EXISTING_DB_URL") else {
        eprintln!("GT_EXISTING_DB_URL not set; skipping");
        return;
    };
    let pool = PgPoolOptions::new().max_connections(2).connect(&url).await.expect("connect");
    let count = |pool: PgPool| async move {
        sqlx::query_scalar::<_, i64>(
            "SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public') \
                  + (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public') \
                  + (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public')",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
    };
    let before = count(pool.clone()).await;
    db::migrate(&pool).await.expect("migration on Go-created schema");
    assert_eq!(count(pool.clone()).await, before, "schema.sql changed a Go-created database");
}
