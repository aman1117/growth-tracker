//! Follow caching and the Redis follow-event pipeline against real PostgreSQL and Redis (ports
//! of the Redis parts of `follow_test.go`). Skipped unless both `TEST_DATABASE_URL` and
//! `REDIS_URL` are set. Redis is shared, so every key and the event channel are unique to this
//! run (users get ids from a random high range) and nothing is flushed. Connection loss is
//! simulated with a local TCP proxy in front of Redis for the subscriber.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{counters, create_user, create_user_with, TestDb};
use gt_core::config::FollowConfig;
use gt_core::models::{
    FOLLOW_EVENT_ACCEPTED, FOLLOW_EVENT_CREATED, FOLLOW_EVENT_DECLINED, FOLLOW_EVENT_REMOVED, FOLLOW_STATE_ACTIVE,
    FOLLOW_STATE_PENDING, FOLLOW_STATE_REMOVED, RELATIONSHIP_FOLLOWING, RELATIONSHIP_INCOMING_PENDING,
    RELATIONSHIP_NONE, RELATIONSHIP_REQUESTED,
};
use gt_core::redis as gt_redis;
use gt_users::repository::{FollowRepository, UserRepository};
use gt_users::service::FollowService;
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use sqlx::PgPool;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

fn rel_key(viewer: i64, target: i64) -> String {
    format!("follow_rel:{viewer}:{target}")
}

fn count_key(user: i64) -> String {
    format!("follow_cnt:{user}")
}

fn config() -> FollowConfig {
    FollowConfig {
        max_follows_per_minute: 60,
        max_follows_per_day: 5000,
        max_total_following: 7500,
        tombstone_retention_days: 7,
    }
}

/// Polls `cond` for up to 5 seconds.
async fn eventually<F, Fut>(what: &str, mut cond: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..500 {
        if cond().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for: {what}");
}

async fn exists(conn: &mut ConnectionManager, key: &str) -> bool {
    conn.exists(key).await.unwrap()
}

async fn numsub(conn: &mut ConnectionManager, channel: &str) -> i64 {
    let (_, n): (String, i64) = redis::cmd("PUBSUB").arg("NUMSUB").arg(channel).query_async(conn).await.unwrap();
    n
}

/// A TCP proxy to Redis whose connections can be cut and which can refuse new ones.
struct Proxy {
    url: String,
    accepting: Arc<AtomicBool>,
    connections: Arc<Mutex<Vec<JoinHandle<()>>>>,
    task: JoinHandle<()>,
}

impl Proxy {
    async fn start(redis_url: &str) -> Proxy {
        let mut url = url::Url::parse(redis_url).unwrap();
        let upstream = (url.host_str().unwrap().to_string(), url.port().unwrap_or(6379));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        url.set_host(Some("127.0.0.1")).unwrap();
        url.set_port(Some(listener.local_addr().unwrap().port())).unwrap();
        let accepting = Arc::new(AtomicBool::new(true));
        let connections = Arc::new(Mutex::new(Vec::new()));
        let (open, conns) = (accepting.clone(), connections.clone());
        let task = tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                if !open.load(Ordering::SeqCst) {
                    continue; // dropped: connection refused
                }
                let Ok(mut outbound) = TcpStream::connect((upstream.0.as_str(), upstream.1)).await else { continue };
                let copy = tokio::spawn(async move {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                });
                conns.lock().unwrap().push(copy);
            }
        });
        Proxy { url: url.to_string(), accepting, connections, task }
    }

    /// Cuts every proxied connection.
    fn cut(&self) {
        for connection in self.connections.lock().unwrap().drain(..) {
            connection.abort();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn follow_caches_and_event_pipeline_with_redis() {
    let Ok(redis_url) = std::env::var("REDIS_URL") else {
        eprintln!("REDIS_URL not set; skipping");
        return;
    };
    if std::env::var("TEST_DATABASE_URL").is_err() {
        eprintln!("TEST_DATABASE_URL not set; skipping");
        return;
    }
    if let Err(e) = gt_redis::init(&redis_url).await {
        gt_redis::close();
        eprintln!("Redis unavailable ({e:#}); skipping");
        return;
    }
    let Some(db) = TestDb::new("follow_redis").await else { return };
    let run = uuid::Uuid::new_v4();
    let id_base = 1_000_000_000_000 + (run.as_u128() % 1_000_000_000) as i64 * 1000;
    sqlx::query("SELECT setval('users_id_seq', $1)").bind(id_base).execute(&db.pool).await.unwrap();

    let mut conn = gt_redis::conn().unwrap();
    let mut keys = Vec::new();
    caching(&db.pool, &mut conn, &mut keys).await;
    event_pipeline(&db.pool, &mut conn, &mut keys, &redis_url, &run.to_string(), id_base + 500).await;

    let _: () = conn.del(&keys).await.unwrap();
    gt_redis::close();
    db.finish().await;
}

/// Relationship and count caches (Go `TestFollowService_Relationships` / `_Counts` / `_Follow`).
async fn caching(pool: &PgPool, conn: &mut ConnectionManager, keys: &mut Vec<String>) {
    let users = Arc::new(UserRepository::new(pool.clone()));
    let repo = Arc::new(FollowRepository::new(pool.clone()));
    let svc = FollowService::new(repo.clone(), users.clone(), config());
    let viewer = create_user(&users, "viewer").await;
    let followed = create_user(&users, "followed").await;
    let requested = create_user_with(&users, "requested", true).await;
    let requester = create_user(&users, "requester").await;
    let stranger = create_user(&users, "stranger").await;
    let fan = create_user(&users, "fan").await;
    for user in [&viewer, &followed, &requested, &requester, &stranger, &fan] {
        keys.push(count_key(user.id));
        for other in [&viewer, &followed, &requested, &requester, &stranger, &fan] {
            keys.push(rel_key(user.id, other.id));
        }
    }
    svc.follow(viewer.id, followed.id).await.unwrap();
    svc.follow(viewer.id, requested.id).await.unwrap();
    repo.create_follow_with_counters(requester.id, viewer.id, FOLLOW_STATE_PENDING, None).await.unwrap();

    // Relationship lookups are cached per pair for 5 minutes.
    let targets = [followed.id, requested.id, requester.id, stranger.id];
    let want = [RELATIONSHIP_FOLLOWING, RELATIONSHIP_REQUESTED, RELATIONSHIP_INCOMING_PENDING, RELATIONSHIP_NONE];
    let got = svc.lookup_relationships(viewer.id, &targets).await.unwrap();
    for (target, state) in targets.iter().zip(want) {
        assert_eq!(got[target], state);
        let cached: String = conn.get(rel_key(viewer.id, *target)).await.unwrap();
        assert_eq!(cached, state);
        let ttl: i64 = conn.ttl(rel_key(viewer.id, *target)).await.unwrap();
        assert!((290..=300).contains(&ttl), "ttl {ttl}");
    }
    let _: () = conn.set(rel_key(viewer.id, stranger.id), RELATIONSHIP_FOLLOWING).await.unwrap();
    let _: () = conn.del(rel_key(viewer.id, followed.id)).await.unwrap();
    let got = svc.lookup_relationships(viewer.id, &[stranger.id, followed.id]).await.unwrap();
    assert_eq!(got[&stranger.id], RELATIONSHIP_FOLLOWING, "served from the cache");
    assert_eq!(got[&followed.id], RELATIONSHIP_FOLLOWING, "recomputed");
    assert_eq!(svc.get_relationship_state(viewer.id, stranger.id).await.unwrap(), RELATIONSHIP_FOLLOWING);

    // Follow operations invalidate the pair and both users' counts.
    let _: () = conn.del(rel_key(viewer.id, stranger.id)).await.unwrap();
    let _: () = conn.set(rel_key(fan.id, stranger.id), RELATIONSHIP_NONE).await.unwrap();
    let _: () = conn.hset(count_key(fan.id), "following", "0").await.unwrap();
    let _: () = conn.hset(count_key(stranger.id), "followers", "0").await.unwrap();
    assert_eq!(svc.follow(fan.id, stranger.id).await.unwrap().state, FOLLOW_STATE_ACTIVE);
    for key in [rel_key(fan.id, stranger.id), count_key(fan.id), count_key(stranger.id)] {
        assert!(!exists(conn, &key).await, "{key} invalidated");
    }
    let _: () = conn.set(rel_key(fan.id, stranger.id), RELATIONSHIP_FOLLOWING).await.unwrap();
    svc.unfollow(fan.id, stranger.id).await.unwrap();
    assert!(!exists(conn, &rel_key(fan.id, stranger.id)).await);
    assert_eq!(svc.get_relationship_state(fan.id, stranger.id).await.unwrap(), RELATIONSHIP_NONE);

    // Counts are cached in a hash for 5 minutes; cached values win; missing fields read as 0.
    repo.create_follow_with_counters(fan.id, followed.id, FOLLOW_STATE_ACTIVE, None).await.unwrap();
    assert_eq!(svc.get_follow_counts(followed.id).await.unwrap(), (2, 0));
    let cached: (String, String) = redis::cmd("HMGET")
        .arg(count_key(followed.id))
        .arg("followers")
        .arg("following")
        .query_async(conn)
        .await
        .unwrap();
    assert_eq!(cached, ("2".to_string(), "0".to_string()));
    let ttl: i64 = conn.ttl(count_key(followed.id)).await.unwrap();
    assert!((290..=300).contains(&ttl), "ttl {ttl}");
    let _: () = redis::cmd("HSET")
        .arg(count_key(followed.id))
        .arg("followers")
        .arg("40")
        .arg("following")
        .arg("7")
        .query_async(conn)
        .await
        .unwrap();
    assert_eq!(svc.get_follow_counts(followed.id).await.unwrap(), (40, 7));
    let _: () = conn.del(count_key(followed.id)).await.unwrap();
    let _: () = conn.hset(count_key(followed.id), "followers", "5").await.unwrap();
    assert_eq!(svc.get_follow_counts(followed.id).await.unwrap(), (5, 0));

    // Reconcile repairs the row and drops the cached counts.
    sqlx::query("UPDATE follow_counters SET followers_count = 99, following_count = -3 WHERE user_id = $1")
        .bind(followed.id)
        .execute(pool)
        .await
        .unwrap();
    svc.reconcile_counters(followed.id).await.unwrap();
    assert_eq!(counters(pool, followed.id).await, (2, 0, 0));
    assert!(!exists(conn, &count_key(followed.id)).await);

    // Accept / decline / remove also invalidate.
    let _: () = conn.set(rel_key(viewer.id, requested.id), RELATIONSHIP_REQUESTED).await.unwrap();
    svc.accept_request(requested.id, viewer.id).await.unwrap();
    assert_eq!(svc.get_relationship_state(viewer.id, requested.id).await.unwrap(), RELATIONSHIP_FOLLOWING);
    svc.remove_follower(requested.id, viewer.id).await.unwrap();
    assert_eq!(svc.get_relationship_state(viewer.id, requested.id).await.unwrap(), RELATIONSHIP_NONE);
    let _: () = conn.set(rel_key(requester.id, viewer.id), RELATIONSHIP_REQUESTED).await.unwrap();
    svc.decline_request(viewer.id, requester.id).await.unwrap();
    assert!(!exists(conn, &rel_key(requester.id, viewer.id)).await);
}

/// The follow-event channel (Go `TestFollowService_PublishFollowEvent_*` / `_CounterSubscriber`).
async fn event_pipeline(
    pool: &PgPool,
    conn: &mut ConnectionManager,
    keys: &mut Vec<String>,
    redis_url: &str,
    run: &str,
    base: i64,
) {
    let channel = format!("follow_events_test_{run}");
    let users = Arc::new(UserRepository::new(pool.clone()));
    let repo = Arc::new(FollowRepository::new(pool.clone()));
    let svc = Arc::new(FollowService::new(repo, users, config()).with_event_channel(channel.clone()));
    let id = |n: i64| base + n;
    keys.extend((1..=12).map(|n| count_key(id(n))));

    // Nobody subscribed: the event would be lost, so counters are updated synchronously.
    svc.publish_follow_event(FOLLOW_EVENT_CREATED, id(11), id(12), FOLLOW_STATE_ACTIVE).await;
    assert_eq!(counters(pool, id(11)).await, (0, 1, 0));
    assert_eq!(counters(pool, id(12)).await, (1, 0, 0));

    // The subscriber's dedicated connection goes through the proxy; commands stay direct.
    let proxy = Proxy::start(redis_url).await;
    gt_redis::set_handle(Some(gt_redis::RedisHandle {
        client: redis::Client::open(proxy.url.as_str()).unwrap(),
        conn: conn.clone(),
    }));
    let handle = svc.start_follow_counter_subscriber().expect("Redis is available");
    eventually("subscribed", || {
        let mut conn = conn.clone();
        let channel = channel.clone();
        async move { numsub(&mut conn, &channel).await == 1 }
    })
    .await;

    let wait_counters = |user: i64, want: (i64, i64, i64), what: &'static str| {
        let pool = pool.clone();
        async move {
            eventually(what, || {
                let pool = pool.clone();
                async move { counters(&pool, user).await == want }
            })
            .await
        }
    };

    let _: () = conn.hset(count_key(id(1)), "following", "0").await.unwrap();
    let _: () = conn.hset(count_key(id(2)), "followers", "0").await.unwrap();
    let _: i64 = conn.publish(&channel, "not json").await.unwrap();
    svc.publish_follow_event(FOLLOW_EVENT_CREATED, id(1), id(2), FOLLOW_STATE_ACTIVE).await;
    wait_counters(id(2), (1, 0, 0), "direct follow").await;
    assert_eq!(counters(pool, id(1)).await, (0, 1, 0), "applied once (not also synchronously)");
    eventually("count caches invalidated", || {
        let mut conn = conn.clone();
        async move { !exists(&mut conn, &count_key(id(1))).await && !exists(&mut conn, &count_key(id(2))).await }
    })
    .await;

    svc.publish_follow_event(FOLLOW_EVENT_CREATED, id(3), id(4), FOLLOW_STATE_PENDING).await;
    wait_counters(id(4), (0, 0, 1), "follow request").await;
    svc.publish_follow_event(FOLLOW_EVENT_ACCEPTED, id(3), id(4), FOLLOW_STATE_ACTIVE).await;
    wait_counters(id(4), (1, 0, 0), "request accepted").await;
    wait_counters(id(3), (0, 1, 0), "requester following").await;
    svc.publish_follow_event(FOLLOW_EVENT_REMOVED, id(3), id(4), FOLLOW_STATE_REMOVED).await;
    wait_counters(id(4), (0, 0, 0), "unfollow").await;
    wait_counters(id(3), (0, 0, 0), "unfollow (follower)").await;
    svc.publish_follow_event(FOLLOW_EVENT_CREATED, id(5), id(6), FOLLOW_STATE_PENDING).await;
    wait_counters(id(6), (0, 0, 1), "second request").await;
    svc.publish_follow_event(FOLLOW_EVENT_DECLINED, id(5), id(6), FOLLOW_STATE_REMOVED).await;
    wait_counters(id(6), (0, 0, 0), "request declined").await;

    let _: () = conn.hset(count_key(id(9)), "followers", "1").await.unwrap();
    svc.publish_follow_event("FOLLOW_UNKNOWN", id(9), id(10), FOLLOW_STATE_ACTIVE).await;
    eventually("unknown events only invalidate caches", || {
        let mut conn = conn.clone();
        async move { !exists(&mut conn, &count_key(id(9))).await }
    })
    .await;
    assert_eq!(counters(pool, id(10)).await, (0, 0, 0));

    // The subscriber survives losing its connection, including failed resubscribe attempts.
    proxy.accepting.store(false, Ordering::SeqCst);
    proxy.cut();
    eventually("subscription lost", || {
        let mut conn = conn.clone();
        let channel = channel.clone();
        async move { numsub(&mut conn, &channel).await == 0 }
    })
    .await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    proxy.accepting.store(true, Ordering::SeqCst);
    eventually("resubscribed", || {
        let mut conn = conn.clone();
        let channel = channel.clone();
        async move { numsub(&mut conn, &channel).await == 1 }
    })
    .await;
    svc.publish_follow_event(FOLLOW_EVENT_CREATED, id(7), id(8), FOLLOW_STATE_ACTIVE).await;
    wait_counters(id(8), (1, 0, 0), "event after resubscribing").await;
    assert_eq!(counters(pool, id(7)).await, (0, 1, 0));

    handle.abort();
    eventually("subscription closed", || {
        let mut conn = conn.clone();
        let channel = channel.clone();
        async move { numsub(&mut conn, &channel).await == 0 }
    })
    .await;
    proxy.task.abort();
    proxy.cut();
}
