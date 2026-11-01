//! Database tests of the comment repositories (port of `comment_repository_test.go`). They run
//! only when `TEST_DATABASE_URL` points at a PostgreSQL server whose role may create
//! databases; each test uses its own database.

use std::time::Duration;

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use gt_comments::repository::{
    CommentDedupeRepository, CommentLikeRepository, CommentMentionRepository, CommentRepository, CommentWithAuthor,
    NewComment, NewCommentDedupe, NewCommentMention,
};
use gt_comments::service::count_cache;
use gt_core::models::{Comment, User};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};

// ==================== Fixtures ====================

struct TestDb {
    pool: PgPool,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// A freshly migrated database named after the test, or `None` (skip) without
    /// `TEST_DATABASE_URL`.
    async fn new(test: &str) -> Option<TestDb> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_comments_{test}");
        let mut admin = PgConnection::connect(&admin_url).await.expect("connect admin");
        sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
        let mut url = url::Url::parse(&admin_url).unwrap();
        url.set_path(&format!("/{name}"));
        let pool = PgPoolOptions::new().max_connections(4).connect(url.as_str()).await.expect("connect test db");
        gt_core::db::migrate(&pool).await.expect("migrate");
        Some(TestDb { pool, admin_url, name })
    }

    async fn finish(self) {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.admin_url).await.unwrap();
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name)).execute(&mut admin).await;
    }
}

/// A pool whose every query fails (Go `testutil.BrokenDB`).
async fn broken_pool() -> PgPool {
    let pool = PgPoolOptions::new().connect_lazy("postgres://nobody:nothing@127.0.0.1:1/none").unwrap();
    pool.close().await;
    pool
}

fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 3, 1, 12, 0, 0).unwrap()
}

fn day() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 3, 9).unwrap()
}

fn next_day() -> NaiveDate {
    day().succ_opt().unwrap()
}

fn minutes(n: i64) -> chrono::Duration {
    chrono::Duration::minutes(n)
}

#[derive(Default)]
struct UserOpts {
    verified: bool,
    avatar: bool,
}

async fn create_user(pool: &PgPool, username: &str, opts: UserOpts) -> User {
    let (pic, thumb) = if opts.avatar {
        (
            Some(format!("https://blob.example.com/avatars/{username}.jpg")),
            Some(format!("https://blob.example.com/avatars/{username}_thumb.jpg")),
        )
    } else {
        (None, None)
    };
    let sql = format!(
        "INSERT INTO users (email, username, password_hash, profile_pic, profile_pic_thumb, is_verified, email_verified) \
         VALUES ($1, $2, 'hash', $3, $4, $5, true) RETURNING {}",
        User::COLUMNS
    );
    sqlx::query_as::<_, User>(&sql)
        .bind(format!("{username}@example.com"))
        .bind(username)
        .bind(pic)
        .bind(thumb)
        .bind(opts.verified)
        .fetch_one(pool)
        .await
        .expect("create user")
}

async fn user(pool: &PgPool, username: &str) -> User {
    create_user(pool, username, UserOpts::default()).await
}

/// Go `createComment`: replies point at their parent, the thread root and the parent author.
async fn create_comment(
    repo: &CommentRepository,
    owner_id: i64,
    day_date: NaiveDate,
    author_id: i64,
    parent: Option<&Comment>,
    body: &str,
    created_at: DateTime<Utc>,
) -> Comment {
    let new = NewComment {
        day_owner_id: owner_id,
        day_date,
        author_id,
        parent_comment_id: parent.map(|p| p.id),
        root_comment_id: parent.map(|p| p.root_comment_id.unwrap_or(p.id)),
        reply_to_user_id: parent.map(|p| p.author_id),
        body: body.to_string(),
        created_at: Some(created_at),
    };
    repo.create(&new).await.expect("create comment")
}

fn ids(rows: &[CommentWithAuthor]) -> Vec<i64> {
    rows.iter().map(|c| c.comment.id).collect()
}

async fn load(pool: &PgPool, id: i64) -> Comment {
    CommentRepository::new(pool.clone()).get_by_id(id).await.unwrap().expect("comment exists")
}

// ==================== Comments ====================

#[tokio::test]
async fn comment_create_and_get() {
    let Some(db) = TestDb::new("create_and_get").await else { return };
    let repo = CommentRepository::new(db.pool.clone());
    let owner = user(&db.pool, "owner").await;
    let author = create_user(&db.pool, "author", UserOpts { verified: true, avatar: true }).await;

    let created = repo
        .create(&NewComment {
            day_owner_id: owner.id,
            day_date: day(),
            author_id: author.id,
            parent_comment_id: None,
            root_comment_id: None,
            reply_to_user_id: None,
            body: "Great día! 🎉".into(),
            created_at: None,
        })
        .await
        .unwrap();
    assert!(created.id > 0);
    assert!((Utc::now() - created.created_at).num_seconds().abs() < 60, "creation time defaults to now");

    let got = repo.get_by_id(created.id).await.unwrap().unwrap();
    assert_eq!(got, created);
    assert_eq!(got.body, "Great día! 🎉");
    assert_eq!(got.day_date, day());
    assert!(got.is_top_level());
    assert_eq!((got.like_count, got.reply_count, got.is_edited, got.is_deleted), (0, 0, false, false));

    let with_author = repo.get_by_id_with_author(created.id).await.unwrap().unwrap();
    assert_eq!(with_author.comment, created);
    assert_eq!(with_author.author_username, "author");
    assert_eq!(with_author.author_avatar, author.profile_pic);
    assert_eq!(with_author.author_avatar_thumb, author.profile_pic_thumb);
    assert!(with_author.author_verified);

    assert_eq!(repo.get_by_id(9999).await.unwrap(), None);
    assert_eq!(repo.get_by_id_with_author(9999).await.unwrap(), None);
    db.finish().await;
}

#[tokio::test]
async fn comment_create_with_unknown_author_fails() {
    let Some(db) = TestDb::new("unknown_author").await else { return };
    let repo = CommentRepository::new(db.pool.clone());
    let result = repo
        .create(&NewComment {
            day_owner_id: 1,
            day_date: day(),
            author_id: 9999,
            parent_comment_id: None,
            root_comment_id: None,
            reply_to_user_id: None,
            body: "hi".into(),
            created_at: None,
        })
        .await;
    assert!(result.is_err());
    db.finish().await;
}

#[tokio::test]
async fn comment_top_level_by_day() {
    let Some(db) = TestDb::new("top_level_by_day").await else { return };
    let repo = CommentRepository::new(db.pool.clone());
    let (owner, other) = (user(&db.pool, "owner").await, user(&db.pool, "other").await);
    let author = user(&db.pool, "commenter").await;
    let c1 = create_comment(&repo, owner.id, day(), author.id, None, "first", t0() + minutes(1)).await;
    let c2 = create_comment(&repo, owner.id, day(), other.id, None, "second", t0() + minutes(2)).await;
    let c3 = create_comment(&repo, owner.id, day(), author.id, None, "third", t0() + minutes(3)).await;
    create_comment(&repo, owner.id, day(), other.id, Some(&c1), "a reply", t0() + minutes(4)).await;
    create_comment(&repo, owner.id, next_day(), author.id, None, "another day", t0()).await;
    create_comment(&repo, other.id, day(), author.id, None, "another owner", t0()).await;

    let got = repo.get_top_level_by_day(owner.id, day(), None, 5).await.unwrap();
    assert_eq!(ids(&got), vec![c3.id, c2.id, c1.id], "top-level comments only, newest first");
    assert_eq!(got[0].author_username, "commenter");

    let got = repo.get_top_level_by_day(owner.id, day(), None, 1).await.unwrap();
    assert_eq!(ids(&got), vec![c3.id, c2.id], "one extra row signals another page");

    let got = repo.get_top_level_by_day(owner.id, day(), Some(c2.id), 5).await.unwrap();
    assert_eq!(ids(&got), vec![c1.id], "cursor continues after the given comment");

    let got = repo.get_top_level_by_day(owner.id, day(), Some(0), 5).await.unwrap();
    assert_eq!(got.len(), 3, "a zero cursor means the first page");

    let got = repo.get_top_level_by_day(author.id, day(), None, 5).await.unwrap();
    assert!(got.is_empty());
    db.finish().await;
}

#[tokio::test]
async fn comment_replies_by_root() {
    let Some(db) = TestDb::new("replies_by_root").await else { return };
    let repo = CommentRepository::new(db.pool.clone());
    let (owner, author) = (user(&db.pool, "owner").await, user(&db.pool, "author").await);
    let root = create_comment(&repo, owner.id, day(), author.id, None, "root", t0()).await;
    let other_root = create_comment(&repo, owner.id, day(), author.id, None, "other root", t0()).await;
    let r1 = create_comment(&repo, owner.id, day(), owner.id, Some(&root), "reply 1", t0() + minutes(1)).await;
    let r2 = create_comment(&repo, owner.id, day(), author.id, Some(&root), "reply 2", t0() + minutes(2)).await;
    let nested =
        create_comment(&repo, owner.id, day(), author.id, Some(&r1), "reply to reply 1", t0() + minutes(3)).await;
    create_comment(&repo, owner.id, day(), author.id, Some(&other_root), "elsewhere", t0() + minutes(4)).await;

    let got = repo.get_replies_by_root(root.id, None, 10).await.unwrap();
    assert_eq!(ids(&got), vec![r1.id, r2.id, nested.id], "the whole thread, oldest first");
    assert_eq!(got[2].comment.parent_comment_id, Some(r1.id));
    assert_eq!(got[2].comment.root_comment_id, Some(root.id));
    assert_eq!(got[2].comment.reply_to_user_id, Some(owner.id));

    let got = repo.get_replies_by_root(root.id, None, 1).await.unwrap();
    assert_eq!(ids(&got), vec![r1.id, r2.id], "limit plus one");

    let got = repo.get_replies_by_root(root.id, Some(r1.id), 10).await.unwrap();
    assert_eq!(ids(&got), vec![r2.id, nested.id]);
    db.finish().await;
}

#[tokio::test]
async fn comment_soft_delete_and_update_body() {
    let Some(db) = TestDb::new("soft_delete_update").await else { return };
    let repo = CommentRepository::new(db.pool.clone());
    let (owner, author) = (user(&db.pool, "owner").await, user(&db.pool, "author").await);
    let doomed = create_comment(&repo, owner.id, day(), author.id, None, "oops", t0()).await;
    let edited = create_comment(&repo, owner.id, day(), author.id, None, "typo", t0()).await;
    sqlx::query("UPDATE comments SET updated_at = $1").bind(t0()).execute(&db.pool).await.unwrap();

    repo.soft_delete(doomed.id).await.unwrap();
    let got = load(&db.pool, doomed.id).await;
    assert!(got.is_deleted);
    assert_eq!(got.body, "[Deleted]");
    assert!(got.updated_at > t0(), "GORM updates touch updated_at");
    let first_deleted_at = got.deleted_at.expect("deleted_at is set");

    repo.soft_delete(doomed.id).await.unwrap();
    assert_eq!(
        load(&db.pool, doomed.id).await.deleted_at,
        Some(first_deleted_at),
        "deleting twice keeps the original time"
    );

    repo.update_body(doomed.id, "resurrected").await.unwrap();
    let got = load(&db.pool, doomed.id).await;
    assert_eq!(got.body, "[Deleted]", "deleted comments cannot be edited");
    assert!(!got.is_edited);

    repo.update_body(edited.id, "fixed ✏️").await.unwrap();
    let got = load(&db.pool, edited.id).await;
    assert_eq!(got.body, "fixed ✏️");
    assert!(got.is_edited);
    assert!(!got.is_deleted);
    assert!(got.updated_at > t0());
    db.finish().await;
}

#[tokio::test]
async fn comment_ancestor_reply_counts() {
    let Some(db) = TestDb::new("ancestor_reply_counts").await else { return };
    let repo = CommentRepository::new(db.pool.clone());
    let (owner, author) = (user(&db.pool, "owner").await, user(&db.pool, "author").await);
    let root = create_comment(&repo, owner.id, day(), author.id, None, "root", t0()).await;
    let child = create_comment(&repo, owner.id, day(), author.id, Some(&root), "child", t0()).await;
    let grandchild = create_comment(&repo, owner.id, day(), author.id, Some(&child), "grandchild", t0()).await;
    let unrelated = create_comment(&repo, owner.id, day(), author.id, None, "unrelated", t0()).await;
    let pool = db.pool.clone();
    let counts = || {
        let pool = pool.clone();
        async move {
            let mut out = [0i64; 4];
            for (slot, id) in out.iter_mut().zip([root.id, child.id, grandchild.id, unrelated.id]) {
                *slot = load(&pool, id).await.reply_count;
            }
            out
        }
    };

    repo.increment_ancestor_reply_counts(grandchild.id).await.unwrap();
    assert_eq!(counts().await, [1, 1, 0, 0], "every ancestor is incremented");
    repo.increment_ancestor_reply_counts(child.id).await.unwrap();
    assert_eq!(counts().await, [2, 1, 0, 0]);
    repo.increment_ancestor_reply_counts(root.id).await.unwrap();
    assert_eq!(counts().await, [2, 1, 0, 0], "top-level comments have no ancestors");

    repo.decrement_ancestor_reply_counts(grandchild.id).await.unwrap();
    assert_eq!(counts().await, [1, 0, 0, 0]);
    repo.decrement_ancestor_reply_counts(grandchild.id).await.unwrap();
    assert_eq!(counts().await, [0, 0, 0, 0], "counts never go below zero");
    repo.decrement_ancestor_reply_counts(child.id).await.unwrap();
    assert_eq!(counts().await, [0, 0, 0, 0]);
    db.finish().await;
}

#[tokio::test]
async fn comment_count_for_day() {
    let Some(db) = TestDb::new("count_for_day").await else { return };
    let repo = CommentRepository::new(db.pool.clone());
    let (owner, author) = (user(&db.pool, "owner").await, user(&db.pool, "author").await);
    let c1 = create_comment(&repo, owner.id, day(), author.id, None, "one", t0()).await;
    create_comment(&repo, owner.id, day(), author.id, None, "two", t0()).await;
    create_comment(&repo, owner.id, day(), author.id, Some(&c1), "reply", t0()).await;
    let deleted = create_comment(&repo, owner.id, day(), author.id, None, "gone", t0()).await;
    repo.soft_delete(deleted.id).await.unwrap();
    create_comment(&repo, owner.id, next_day(), author.id, None, "tomorrow", t0()).await;

    assert_eq!(
        repo.get_comment_count_for_day(owner.id, day()).await.unwrap(),
        3,
        "replies count, deleted comments do not"
    );
    assert_eq!(repo.get_comment_count_for_day(author.id, day()).await.unwrap(), 0);
    db.finish().await;
}

#[tokio::test]
async fn comment_reply_to_username() {
    let Some(db) = TestDb::new("reply_to_username").await else { return };
    let repo = CommentRepository::new(db.pool.clone());
    let target = user(&db.pool, "replied_to").await;

    assert_eq!(repo.get_reply_to_username(target.id).await.unwrap().as_deref(), Some("replied_to"));
    assert_eq!(repo.get_reply_to_username(9999).await.unwrap(), None);
    db.finish().await;
}

/// Without Redis the count comes from the database; with Redis it is cached for 5 minutes, a
/// cached value wins, a non-integer value is ignored and writes invalidate it.
#[tokio::test]
async fn comment_count_cache() {
    let Some(db) = TestDb::new("count_cache").await else { return };
    let repo = CommentRepository::new(db.pool.clone());
    let author = user(&db.pool, "author").await;
    // `day_owner_id` has no foreign key: a large pseudo-random owner keeps the Redis keys of this
    // test apart from anything else using the shared server.
    let owner_id = 7_000_000_000 + i64::from(std::process::id());
    let top = create_comment(&repo, owner_id, day(), author.id, None, "one", t0()).await;
    create_comment(&repo, owner_id, day(), author.id, Some(&top), "two", t0()).await;
    let gone = create_comment(&repo, owner_id, day(), author.id, None, "deleted", t0()).await;
    repo.soft_delete(gone.id).await.unwrap();

    gt_core::redis::set_handle(None);
    assert_eq!(count_cache::get_comment_count(&repo, owner_id, day()).await.unwrap(), 2);
    count_cache::invalidate_count_cache(owner_id, day()).await;

    if let Ok(redis_url) = std::env::var("REDIS_URL") {
        gt_core::redis::init(&redis_url).await.expect("connect redis");
        let key = count_cache::comment_count_cache_key(owner_id, day());
        let mut conn = gt_core::redis::conn().unwrap();
        let raw = |conn: &mut redis::aio::ConnectionManager| {
            let mut conn = conn.clone();
            let key = key.clone();
            async move { redis::cmd("GET").arg(&key).query_async::<Option<String>>(&mut conn).await.unwrap() }
        };
        let _: () = redis::cmd("DEL").arg(&key).query_async(&mut conn).await.unwrap();

        assert_eq!(count_cache::get_comment_count(&repo, owner_id, day()).await.unwrap(), 2);
        assert_eq!(raw(&mut conn).await.as_deref(), Some("2"));
        let ttl: i64 = redis::cmd("TTL").arg(&key).query_async(&mut conn).await.unwrap();
        assert!((295..=300).contains(&ttl), "cached for 5 minutes, got {ttl}");

        let _: () = redis::cmd("SET").arg(&key).arg("11").query_async(&mut conn).await.unwrap();
        assert_eq!(count_cache::get_comment_count(&repo, owner_id, day()).await.unwrap(), 11, "cache hit");

        let _: () = redis::cmd("SET").arg(&key).arg("not a number").query_async(&mut conn).await.unwrap();
        assert_eq!(count_cache::get_comment_count(&repo, owner_id, day()).await.unwrap(), 2);
        assert_eq!(raw(&mut conn).await.as_deref(), Some("2"), "a corrupt value is replaced");

        count_cache::invalidate_count_cache(owner_id, day()).await;
        assert_eq!(raw(&mut conn).await, None);
        gt_core::redis::close();
    } else {
        eprintln!("REDIS_URL not set; skipping the cached part");
    }
    db.finish().await;
}

// ==================== Comment likes ====================

#[tokio::test]
async fn comment_likes() {
    let Some(db) = TestDb::new("likes").await else { return };
    let comments = CommentRepository::new(db.pool.clone());
    let repo = CommentLikeRepository::new(db.pool.clone());
    let owner = user(&db.pool, "owner").await;
    let (alice, bob) = (user(&db.pool, "alice").await, user(&db.pool, "bob").await);
    let c1 = create_comment(&comments, owner.id, day(), owner.id, None, "one", t0()).await;
    let c2 = create_comment(&comments, owner.id, day(), owner.id, None, "two", t0()).await;
    let c3 = create_comment(&comments, owner.id, day(), owner.id, None, "three", t0()).await;

    assert!(repo.create(c1.id, alice.id).await.unwrap());
    assert!(!repo.create(c1.id, alice.id).await.unwrap(), "a second like by the same user is ignored");
    assert!(repo.create(c1.id, bob.id).await.unwrap());
    assert!(repo.create(c3.id, alice.id).await.unwrap());

    assert!(repo.has_liked(c1.id, alice.id).await.unwrap());
    assert!(!repo.has_liked(c2.id, alice.id).await.unwrap());

    let batch = repo.batch_has_liked(&[c1.id, c2.id, c3.id], alice.id).await.unwrap();
    assert_eq!(batch, [c1.id, c3.id].into_iter().collect());
    assert!(repo.batch_has_liked(&[], alice.id).await.unwrap().is_empty());

    assert!(repo.delete(c1.id, alice.id).await.unwrap());
    assert!(!repo.delete(c1.id, alice.id).await.unwrap(), "nothing left to delete");
    assert!(repo.has_liked(c1.id, bob.id).await.unwrap(), "other users' likes are kept");
    db.finish().await;
}

#[tokio::test]
async fn comment_like_counts() {
    let Some(db) = TestDb::new("like_counts").await else { return };
    let comments = CommentRepository::new(db.pool.clone());
    let repo = CommentLikeRepository::new(db.pool.clone());
    let owner = user(&db.pool, "owner").await;
    let comment = create_comment(&comments, owner.id, day(), owner.id, None, "popular", t0()).await;
    let other = create_comment(&comments, owner.id, day(), owner.id, None, "other", t0()).await;
    sqlx::query("UPDATE comments SET updated_at = $1").bind(t0()).execute(&db.pool).await.unwrap();

    repo.increment_like_count(comment.id).await.unwrap();
    repo.increment_like_count(comment.id).await.unwrap();
    assert_eq!(load(&db.pool, comment.id).await.like_count, 2);

    repo.decrement_like_count(comment.id).await.unwrap();
    assert_eq!(load(&db.pool, comment.id).await.like_count, 1);
    repo.decrement_like_count(comment.id).await.unwrap();
    repo.decrement_like_count(comment.id).await.unwrap();
    let stored = load(&db.pool, comment.id).await;
    assert_eq!(stored.like_count, 0, "never below zero");
    assert_eq!(stored.updated_at, t0(), "UpdateColumn leaves updated_at alone");
    assert_eq!(load(&db.pool, other.id).await.like_count, 0);
    db.finish().await;
}

// ==================== Comment mentions ====================

#[tokio::test]
async fn comment_mentions() {
    let Some(db) = TestDb::new("mentions").await else { return };
    let repo = CommentMentionRepository::new(db.pool.clone());
    let (alice, bob) = (user(&db.pool, "alice").await, user(&db.pool, "bob").await);
    let mention = |comment_id: i64, u: &User| NewCommentMention {
        comment_id,
        mentioned_user_id: u.id,
        username: u.username.clone(),
    };

    repo.create_batch(&[]).await.unwrap();
    repo.create_batch(&[mention(1, &alice), mention(1, &bob), mention(2, &alice)]).await.unwrap();

    let mentions = repo.get_by_comment_id(1).await.unwrap();
    let mut names: Vec<&str> = mentions.iter().map(|m| m.username.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["alice", "bob"]);

    let grouped = repo.get_by_comment_ids(&[1, 2, 3]).await.unwrap();
    assert_eq!(grouped.len(), 2, "comments without mentions are absent");
    assert_eq!(grouped[&1].len(), 2);
    assert_eq!(grouped[&2].len(), 1);
    assert_eq!(grouped[&2][0].mentioned_user_id, alice.id);
    assert!(repo.get_by_comment_ids(&[]).await.unwrap().is_empty());

    repo.delete_by_comment_id(1).await.unwrap();
    assert!(repo.get_by_comment_id(1).await.unwrap().is_empty());
    assert_eq!(repo.get_by_comment_id(2).await.unwrap().len(), 1);

    let too_long = NewCommentMention { comment_id: 3, mentioned_user_id: alice.id, username: "x".repeat(21) };
    assert!(repo.create_batch(&[mention(3, &bob), too_long]).await.is_err(), "usernames are varchar(20)");
    assert!(repo.get_by_comment_id(3).await.unwrap().is_empty(), "a batch is all or nothing");
    db.finish().await;
}

// ==================== Comment dedupe ====================

fn dedupe(user_id: i64, owner_id: i64, body_hash: &str, key: Option<&str>, comment_id: i64) -> NewCommentDedupe {
    NewCommentDedupe {
        user_id,
        day_owner_id: owner_id,
        day_date: day(),
        body_hash: body_hash.to_string(),
        idempotency_key: key.map(str::to_string),
        comment_id,
    }
}

const MINUTE: Duration = Duration::from_secs(60);

#[tokio::test]
async fn comment_dedupe_upsert_and_check() {
    let Some(db) = TestDb::new("dedupe_upsert").await else { return };
    let repo = CommentDedupeRepository::new(db.pool.clone());
    let (u, owner) = (user(&db.pool, "user").await, user(&db.pool, "owner").await);
    const HASH: &str = "5d41402abc4b2a76b9719d911017c592";

    repo.upsert(&dedupe(u.id, owner.id, HASH, Some("key-1"), 10)).await.unwrap();

    let by_key = repo.check_idempotency_key("key-1", MINUTE).await.unwrap().expect("found by key");
    assert_eq!(by_key.comment_id, 10);
    let by_hash = repo.check_body_hash(u.id, owner.id, day(), HASH, MINUTE).await.unwrap().expect("found by hash");
    assert_eq!(by_key.id, by_hash.id);

    assert!(repo.check_idempotency_key("key-2", MINUTE).await.unwrap().is_none(), "unknown key");
    assert!(repo.check_body_hash(u.id, owner.id, day(), "other", MINUTE).await.unwrap().is_none(), "other body");
    assert!(repo.check_body_hash(u.id, owner.id, next_day(), HASH, MINUTE).await.unwrap().is_none(), "other day");
    assert!(repo.check_body_hash(u.id, u.id, day(), HASH, MINUTE).await.unwrap().is_none(), "other day owner");
    assert!(repo.check_body_hash(owner.id, owner.id, day(), HASH, MINUTE).await.unwrap().is_none(), "other commenter");

    // Resubmitting the same body replaces the record.
    repo.upsert(&dedupe(u.id, owner.id, HASH, Some("key-2"), 11)).await.unwrap();
    let got = repo.check_body_hash(u.id, owner.id, day(), HASH, MINUTE).await.unwrap().unwrap();
    assert_eq!(got.comment_id, 11);
    assert!(repo.check_idempotency_key("key-1", MINUTE).await.unwrap().is_none(), "the old key is replaced");
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM comment_dedupes").fetch_one(&db.pool).await.unwrap();
    assert_eq!(rows, 1);

    // An idempotency key cannot be reused for another body.
    assert!(repo.upsert(&dedupe(u.id, owner.id, "different", Some("key-2"), 12)).await.is_err());

    // Records without a key.
    repo.upsert(&dedupe(u.id, owner.id, "a", None, 13)).await.unwrap();
    repo.upsert(&dedupe(u.id, owner.id, "b", None, 14)).await.unwrap();
    let got = repo.check_body_hash(u.id, owner.id, day(), "b", MINUTE).await.unwrap().unwrap();
    assert_eq!(got.idempotency_key, None);
    db.finish().await;
}

#[tokio::test]
async fn comment_dedupe_window_and_cleanup() {
    let Some(db) = TestDb::new("dedupe_window").await else { return };
    let repo = CommentDedupeRepository::new(db.pool.clone());
    let (u, owner) = (user(&db.pool, "user").await, user(&db.pool, "owner").await);
    repo.upsert(&dedupe(u.id, owner.id, "old", Some("old-key"), 1)).await.unwrap();
    repo.upsert(&dedupe(u.id, owner.id, "new", Some("new-key"), 2)).await.unwrap();
    sqlx::query("UPDATE comment_dedupes SET created_at = NOW() - INTERVAL '2 minutes' WHERE body_hash = 'old'")
        .execute(&db.pool)
        .await
        .unwrap();

    assert!(repo.check_idempotency_key("old-key", MINUTE).await.unwrap().is_none(), "outside the window");
    assert!(repo.check_body_hash(u.id, owner.id, day(), "old", MINUTE).await.unwrap().is_none());
    assert!(repo.check_idempotency_key("old-key", 5 * MINUTE).await.unwrap().is_some(), "inside a wider window");

    assert_eq!(repo.cleanup_expired(MINUTE).await.unwrap(), 1);
    assert!(repo.check_idempotency_key("new-key", MINUTE).await.unwrap().is_some(), "recent records survive cleanup");
    assert_eq!(repo.cleanup_expired(MINUTE).await.unwrap(), 0);
    db.finish().await;
}

// ==================== Database errors ====================

#[tokio::test]
async fn database_errors_are_reported() {
    let pool = broken_pool().await;
    let comments = CommentRepository::new(pool.clone());
    let new = NewComment {
        day_owner_id: 1,
        day_date: day(),
        author_id: 1,
        parent_comment_id: None,
        root_comment_id: None,
        reply_to_user_id: None,
        body: "x".into(),
        created_at: None,
    };
    assert!(comments.create(&new).await.is_err());
    assert!(comments.get_by_id(1).await.is_err());
    assert!(comments.get_by_id_with_author(1).await.is_err());
    assert!(comments.get_top_level_by_day(1, day(), None, 10).await.is_err());
    assert!(comments.get_replies_by_root(1, None, 10).await.is_err());
    assert!(comments.soft_delete(1).await.is_err());
    assert!(comments.update_body(1, "x").await.is_err());
    assert!(comments.increment_ancestor_reply_counts(1).await.is_err());
    assert!(comments.decrement_ancestor_reply_counts(1).await.is_err());
    assert!(comments.get_comment_count_for_day(1, day()).await.is_err());
    assert!(comments.get_reply_to_username(1).await.is_err());

    let likes = CommentLikeRepository::new(pool.clone());
    assert!(likes.create(1, 1).await.is_err(), "only duplicate likes are swallowed");
    assert!(likes.delete(1, 1).await.is_err());
    assert!(likes.has_liked(1, 1).await.is_err());
    assert!(likes.increment_like_count(1).await.is_err());
    assert!(likes.decrement_like_count(1).await.is_err());
    assert!(likes.batch_has_liked(&[1], 1).await.is_err());

    let mentions = CommentMentionRepository::new(pool.clone());
    let mention = NewCommentMention { comment_id: 1, mentioned_user_id: 1, username: "a".into() };
    assert!(mentions.create_batch(&[mention]).await.is_err());
    assert!(mentions.get_by_comment_id(1).await.is_err());
    assert!(mentions.delete_by_comment_id(1).await.is_err());
    assert!(mentions.get_by_comment_ids(&[1]).await.is_err());

    let dedupes = CommentDedupeRepository::new(pool);
    assert!(dedupes.check_idempotency_key("k", MINUTE).await.is_err());
    assert!(dedupes.check_body_hash(1, 2, day(), "h", MINUTE).await.is_err());
    assert!(dedupes.upsert(&dedupe(1, 2, "h", None, 1)).await.is_err());
    assert!(dedupes.cleanup_expired(MINUTE).await.is_err());
}
