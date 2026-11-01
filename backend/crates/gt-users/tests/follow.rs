//! Follow repository and service flows against PostgreSQL, without Redis (ports of
//! `follow_repository_test.go` and `follow_test.go`). Skipped without `TEST_DATABASE_URL`.

mod common;

use std::sync::Arc;

use chrono::{Duration, Utc};
use common::{counters, create_user, create_user_with, edge_states, set_edge_times, TestDb};
use gt_core::config::FollowConfig;
use gt_core::models::{
    FOLLOW_EVENT_ACCEPTED, FOLLOW_EVENT_CREATED, FOLLOW_EVENT_DECLINED, FOLLOW_EVENT_REMOVED, FOLLOW_STATE_ACTIVE,
    FOLLOW_STATE_PENDING, FOLLOW_STATE_REMOVED, RELATIONSHIP_FOLLOWING, RELATIONSHIP_INCOMING_PENDING,
    RELATIONSHIP_NONE, RELATIONSHIP_REQUESTED,
};
use gt_users::repository::{FollowListCursor, FollowRepository, UserRepository};
use gt_users::service::{FollowError, FollowResult, FollowService};

fn config() -> FollowConfig {
    FollowConfig {
        max_follows_per_minute: 60,
        max_follows_per_day: 5000,
        max_total_following: 7500,
        tombstone_retention_days: 7,
    }
}

struct Fixture {
    db: TestDb,
    users: Arc<UserRepository>,
    repo: Arc<FollowRepository>,
    svc: FollowService,
}

impl Fixture {
    async fn new(test: &str) -> Option<Fixture> {
        let db = TestDb::new(test).await?;
        let users = Arc::new(UserRepository::new(db.pool.clone()));
        let repo = Arc::new(FollowRepository::new(db.pool.clone()));
        let svc = FollowService::new(repo.clone(), users.clone(), config());
        Some(Fixture { db, users, repo, svc })
    }

    fn service_with(&self, cfg: FollowConfig) -> FollowService {
        FollowService::new(self.repo.clone(), self.users.clone(), cfg)
    }

    async fn make_follow(&self, follower_id: i64, followee_id: i64, state: &str) {
        self.repo.create_follow_with_counters(follower_id, followee_id, state, None).await.unwrap();
    }

    async fn counters(&self, user_id: i64) -> (i64, i64, i64) {
        counters(&self.db.pool, user_id).await
    }

    async fn assert_edge(&self, follower_id: i64, followee_id: i64, state: &str) {
        let expected = Some(state.to_string());
        assert_eq!(edge_states(&self.db.pool, follower_id, followee_id).await, (expected.clone(), expected));
    }
}

fn code(err: FollowError) -> &'static str {
    err.code().expect("API error")
}

#[tokio::test]
async fn follow_unfollow_and_request_lifecycle() {
    let Some(fx) = Fixture::new("follow_lifecycle").await else { return };
    let alice = create_user(&fx.users, "alice").await;
    let bob = create_user(&fx.users, "bob").await;
    let private = create_user_with(&fx.users, "private", true).await;

    // Public account: followed immediately.
    let res = fx.svc.follow(alice.id, bob.id).await.unwrap();
    assert_eq!(res, FollowResult { state: FOLLOW_STATE_ACTIVE, message: "Now following" });
    fx.assert_edge(alice.id, bob.id, FOLLOW_STATE_ACTIVE).await;
    assert!(fx.repo.get_edge(alice.id, bob.id).await.unwrap().unwrap().accepted_at.is_some());
    assert_eq!(fx.counters(alice.id).await, (0, 1, 0));
    assert_eq!(fx.counters(bob.id).await, (1, 0, 0));
    assert!(fx.repo.is_following(alice.id, bob.id).await.unwrap());

    let again = fx.svc.follow(alice.id, bob.id).await.unwrap();
    assert_eq!(again, FollowResult { state: FOLLOW_STATE_ACTIVE, message: "Already following" });
    assert_eq!(fx.counters(bob.id).await, (1, 0, 0));

    // Private account: a pending request.
    let res = fx.svc.follow(alice.id, private.id).await.unwrap();
    assert_eq!(res, FollowResult { state: FOLLOW_STATE_PENDING, message: "Follow request sent" });
    fx.assert_edge(alice.id, private.id, FOLLOW_STATE_PENDING).await;
    assert!(fx.repo.get_edge(alice.id, private.id).await.unwrap().unwrap().accepted_at.is_none());
    assert_eq!(fx.counters(private.id).await, (0, 0, 1));
    let res = fx.svc.follow(alice.id, private.id).await.unwrap();
    assert_eq!(res, FollowResult { state: FOLLOW_STATE_PENDING, message: "Follow request already pending" });
    assert_eq!(fx.counters(private.id).await, (0, 0, 1));

    // Unfollow, then re-follow a REMOVED edge (created_at is kept, counters move again).
    let created_at = fx.repo.get_edge(alice.id, bob.id).await.unwrap().unwrap().created_at;
    fx.svc.unfollow(alice.id, bob.id).await.unwrap();
    fx.assert_edge(alice.id, bob.id, FOLLOW_STATE_REMOVED).await;
    assert_eq!(fx.counters(alice.id).await, (0, 0, 0));
    assert_eq!(fx.counters(bob.id).await, (0, 0, 0));
    assert_eq!(code(fx.svc.unfollow(alice.id, bob.id).await.unwrap_err()), "NOT_FOLLOWING");
    let never = fx.svc.unfollow(bob.id, alice.id).await.unwrap_err();
    assert_eq!(never.to_string(), "NOT_FOLLOWING: not following this user");

    let res = fx.svc.follow(alice.id, bob.id).await.unwrap();
    assert_eq!(res.state, FOLLOW_STATE_ACTIVE);
    assert_eq!(fx.repo.get_edge(alice.id, bob.id).await.unwrap().unwrap().created_at, created_at);
    assert_eq!(fx.counters(bob.id).await, (1, 0, 0));

    // Validation.
    assert_eq!(
        fx.svc.follow(alice.id, alice.id).await.unwrap_err().to_string(),
        "CANNOT_FOLLOW_SELF: cannot follow yourself"
    );
    assert_eq!(
        fx.svc.follow(alice.id, 999_999).await.unwrap_err().to_string(),
        "USER_NOT_FOUND: target user not found"
    );

    // Accept.
    fx.svc.accept_request(private.id, alice.id).await.unwrap();
    fx.assert_edge(alice.id, private.id, FOLLOW_STATE_ACTIVE).await;
    assert!(fx.repo.get_edge(alice.id, private.id).await.unwrap().unwrap().accepted_at.is_some());
    assert_eq!(fx.counters(private.id).await, (1, 0, 0));
    assert_eq!(fx.counters(alice.id).await, (0, 2, 0));
    assert_eq!(code(fx.svc.accept_request(private.id, alice.id).await.unwrap_err()), "NO_FOLLOW_REQUEST");

    // Remove follower.
    fx.svc.remove_follower(private.id, alice.id).await.unwrap();
    fx.assert_edge(alice.id, private.id, FOLLOW_STATE_REMOVED).await;
    assert_eq!(fx.counters(private.id).await, (0, 0, 0));
    assert_eq!(fx.counters(alice.id).await, (0, 1, 0));
    let err = fx.svc.remove_follower(private.id, alice.id).await.unwrap_err();
    assert_eq!(err.to_string(), "NOT_FOLLOWING: user is not following you");

    // Decline.
    fx.svc.follow(bob.id, private.id).await.unwrap();
    fx.svc.decline_request(private.id, bob.id).await.unwrap();
    fx.assert_edge(bob.id, private.id, FOLLOW_STATE_REMOVED).await;
    assert_eq!(fx.counters(private.id).await, (0, 0, 0));
    let err = fx.svc.decline_request(private.id, bob.id).await.unwrap_err();
    assert_eq!(err.to_string(), "NO_FOLLOW_REQUEST: no pending request found");

    // Cancel (a re-request of a REMOVED edge counts as pending again).
    assert_eq!(fx.svc.follow(bob.id, private.id).await.unwrap().state, FOLLOW_STATE_PENDING);
    assert_eq!(fx.counters(private.id).await, (0, 0, 1));
    fx.svc.cancel_request(bob.id, private.id).await.unwrap();
    fx.assert_edge(bob.id, private.id, FOLLOW_STATE_REMOVED).await;
    assert_eq!(fx.counters(private.id).await, (0, 0, 0));
    assert_eq!(code(fx.svc.cancel_request(bob.id, private.id).await.unwrap_err()), "NO_FOLLOW_REQUEST");

    // Unfollowing a pending request withdraws it.
    fx.svc.follow(bob.id, private.id).await.unwrap();
    fx.svc.unfollow(bob.id, private.id).await.unwrap();
    assert_eq!(fx.counters(private.id).await, (0, 0, 0));

    // The transactional counters never drifted.
    for user in [&alice, &bob, &private] {
        let before = fx.counters(user.id).await;
        fx.repo.reconcile_counters(user.id).await.unwrap();
        assert_eq!(fx.counters(user.id).await, before, "{}", user.username);
    }
    fx.db.finish().await;
}

#[tokio::test]
async fn follow_limits() {
    let Some(fx) = Fixture::new("follow_limits").await else { return };
    let alice = create_user(&fx.users, "alice").await;
    let bob = create_user(&fx.users, "bob").await;
    let carol = create_user(&fx.users, "carol").await;
    fx.make_follow(alice.id, bob.id, FOLLOW_STATE_ACTIVE).await;

    let total = fx.service_with(FollowConfig { max_total_following: 1, ..config() });
    let err = total.follow(alice.id, carol.id).await.unwrap_err();
    assert_eq!(err.to_string(), "FOLLOW_LIMIT_EXCEEDED: you have reached the maximum following limit of 1");
    assert_eq!(edge_states(&fx.db.pool, alice.id, carol.id).await, (None, None));

    // Follows made today count against the daily limit even when undone...
    let daily = fx.service_with(FollowConfig { max_follows_per_day: 1, ..config() });
    daily.unfollow(alice.id, bob.id).await.unwrap();
    let err = daily.follow(alice.id, carol.id).await.unwrap_err();
    assert_eq!(err.to_string(), "DAILY_LIMIT_EXCEEDED: you have reached the daily follow limit of 1");

    // ...but not ones made before UTC midnight.
    set_edge_times(&fx.db.pool, alice.id, bob.id, Utc::now() - Duration::days(1)).await;
    assert_eq!(fx.repo.count_daily_follows(alice.id).await.unwrap(), 0);
    assert_eq!(daily.follow(alice.id, carol.id).await.unwrap().state, FOLLOW_STATE_ACTIVE);
    assert_eq!(fx.repo.count_daily_follows(alice.id).await.unwrap(), 1);
    fx.db.finish().await;
}

#[tokio::test]
async fn follow_lists_and_cursors() {
    let Some(fx) = Fixture::new("follow_lists").await else { return };
    let owner = create_user(&fx.users, "owner").await;
    let private = create_user_with(&fx.users, "private", true).await;
    let stranger = create_user(&fx.users, "stranger").await;
    let mut fans = Vec::new();
    for i in 0..3 {
        let fan = create_user(&fx.users, &format!("fan{i}")).await;
        fx.make_follow(fan.id, owner.id, FOLLOW_STATE_ACTIVE).await;
        fx.make_follow(owner.id, fan.id, FOLLOW_STATE_ACTIVE).await;
        fans.push(fan.id);
    }
    fx.make_follow(fans[0], private.id, FOLLOW_STATE_ACTIVE).await;
    fx.make_follow(stranger.id, owner.id, FOLLOW_STATE_PENDING).await;

    // Followers, paginated with a cursor that survives encode/decode.
    let (page1, more) = fx.svc.get_followers(owner.id, owner.id, 2, None).await.unwrap();
    assert_eq!(page1.len(), 2);
    assert!(more);
    let last = page1.last().unwrap();
    let cursor = FollowListCursor::decode(&FollowListCursor::new(last.created_at, last.follower_id).encode()).unwrap();
    let (page2, more) = fx.svc.get_followers(owner.id, owner.id, 2, Some(&cursor)).await.unwrap();
    assert_eq!(page2.len(), 1);
    assert!(!more);
    let mut got: Vec<i64> = page1.iter().chain(&page2).map(|e| e.follower_id).collect();
    got.sort_unstable();
    assert_eq!(got, fans, "pending requests are not followers");
    assert!(page1[0].created_at >= page1[1].created_at, "newest first");

    // Following of a public account is visible to anyone.
    let (edges, more) = fx.svc.get_following(stranger.id, owner.id, 0, None).await.unwrap();
    assert!(!more);
    let mut got: Vec<i64> = edges.iter().map(|e| e.followee_id).collect();
    got.sort_unstable();
    assert_eq!(got, fans);
    let (page, more) = fx.svc.get_following(owner.id, owner.id, 1, None).await.unwrap();
    assert_eq!((page.len(), more), (1, true));

    // Limits outside 1..=100 become the default.
    for limit in [-1, 0, 101] {
        let (edges, more) = fx.svc.get_followers(owner.id, owner.id, limit, None).await.unwrap();
        assert_eq!((edges.len(), more), (3, false), "limit {limit}");
    }

    // Private lists need an accepted follow.
    assert_eq!(code(fx.svc.get_followers(stranger.id, private.id, 10, None).await.unwrap_err()), "ACCOUNT_PRIVATE");
    assert_eq!(code(fx.svc.get_following(stranger.id, private.id, 10, None).await.unwrap_err()), "ACCOUNT_PRIVATE");
    let (edges, _) = fx.svc.get_followers(fans[0], private.id, 10, None).await.unwrap();
    assert_eq!(edges.iter().map(|e| e.follower_id).collect::<Vec<_>>(), vec![fans[0]]);
    let err = fx.svc.get_followers(owner.id, 999_999, 10, None).await.unwrap_err();
    assert_eq!(err.to_string(), "USER_NOT_FOUND: user not found");

    // Pending incoming requests.
    fx.make_follow(private.id, owner.id, FOLLOW_STATE_PENDING).await;
    let (page, more) = fx.svc.get_pending_incoming_requests(owner.id, 1, None).await.unwrap();
    assert_eq!((page.len(), more), (1, true));
    let (all, more) = fx.svc.get_pending_incoming_requests(owner.id, 500, None).await.unwrap();
    assert!(!more);
    let mut got: Vec<i64> = all.iter().map(|e| e.follower_id).collect();
    got.sort_unstable();
    assert_eq!(got, vec![private.id, stranger.id]);
    assert_eq!(fx.svc.get_pending_requests_count(owner.id).await, 2);
    let outgoing = fx.repo.get_pending_outgoing_requests(stranger.id, 10, None).await.unwrap();
    assert_eq!(outgoing.iter().map(|e| e.followee_id).collect::<Vec<_>>(), vec![owner.id]);

    // Equal timestamps: the cursor's user id breaks ties (follower id DESC).
    let same = Utc::now() - Duration::hours(1);
    for fan in &fans {
        set_edge_times(&fx.db.pool, *fan, owner.id, same).await;
    }
    let mut cursor = None;
    let mut seen = Vec::new();
    loop {
        let (page, more) = fx.svc.get_followers(owner.id, owner.id, 1, cursor.as_ref()).await.unwrap();
        let edge = &page[0];
        seen.push(edge.follower_id);
        cursor = Some(FollowListCursor::new(edge.created_at, edge.follower_id));
        if !more {
            break;
        }
    }
    let mut expected = fans.clone();
    expected.reverse();
    assert_eq!(seen, expected);

    let mut ids = fx.repo.get_all_follower_ids(owner.id).await.unwrap();
    ids.sort_unstable();
    assert_eq!(ids, fans);
    fx.db.finish().await;
}

#[tokio::test]
async fn relationships_and_mutuals() {
    let Some(fx) = Fixture::new("follow_relationships").await else { return };
    let viewer = create_user(&fx.users, "viewer").await;
    let followed = create_user(&fx.users, "followed").await;
    let requested = create_user(&fx.users, "requested").await;
    let requester = create_user(&fx.users, "requester").await;
    let stranger = create_user(&fx.users, "stranger").await;
    let both_ways = create_user(&fx.users, "bothways").await;
    fx.make_follow(viewer.id, followed.id, FOLLOW_STATE_ACTIVE).await;
    fx.make_follow(viewer.id, requested.id, FOLLOW_STATE_PENDING).await;
    fx.make_follow(requester.id, viewer.id, FOLLOW_STATE_PENDING).await;
    fx.make_follow(viewer.id, both_ways.id, FOLLOW_STATE_PENDING).await;
    fx.make_follow(both_ways.id, viewer.id, FOLLOW_STATE_PENDING).await;

    let targets = [followed.id, requested.id, requester.id, stranger.id, both_ways.id];
    let got = fx.svc.lookup_relationships(viewer.id, &targets).await.unwrap();
    assert_eq!(got.len(), 5);
    assert_eq!(got[&followed.id], RELATIONSHIP_FOLLOWING);
    assert_eq!(got[&requested.id], RELATIONSHIP_REQUESTED);
    assert_eq!(got[&requester.id], RELATIONSHIP_INCOMING_PENDING);
    assert_eq!(got[&stranger.id], RELATIONSHIP_NONE);
    assert_eq!(got[&both_ways.id], RELATIONSHIP_REQUESTED, "an outgoing edge wins over an incoming request");
    assert_eq!(fx.svc.get_relationship_state(viewer.id, requester.id).await.unwrap(), RELATIONSHIP_INCOMING_PENDING);
    assert!(fx.repo.batch_lookup_relationships(viewer.id, &[]).await.unwrap().is_empty());

    // Mutuals: users the viewer follows who follow a (private) target.
    let target = create_user_with(&fx.users, "target", true).await;
    let friend_a = create_user(&fx.users, "frienda").await;
    let friend_b = create_user(&fx.users, "friendb").await;
    let not_mutual = create_user(&fx.users, "notmutual").await;
    for f in [&friend_a, &friend_b, &not_mutual] {
        fx.make_follow(viewer.id, f.id, FOLLOW_STATE_ACTIVE).await;
    }
    fx.make_follow(friend_a.id, target.id, FOLLOW_STATE_ACTIVE).await;
    fx.make_follow(friend_b.id, target.id, FOLLOW_STATE_ACTIVE).await;
    fx.make_follow(not_mutual.id, target.id, FOLLOW_STATE_PENDING).await;

    let (mut ids, more) = fx.svc.get_mutuals(viewer.id, target.id, 0, None).await.unwrap();
    assert!(!more);
    ids.sort_unstable();
    assert_eq!(ids, vec![friend_a.id, friend_b.id]);
    let (ids, more) = fx.svc.get_mutuals(viewer.id, target.id, 1, None).await.unwrap();
    assert_eq!((ids, more), (vec![friend_b.id], true), "newest follow first");

    let (edges, more) = fx.svc.get_mutuals_with_timestamps(viewer.id, target.id, 1, None).await.unwrap();
    assert_eq!(edges.len(), 1);
    assert!(more);
    let cursor = FollowListCursor::new(edges[0].created_at, edges[0].user_id);
    let (rest, more) = fx.svc.get_mutuals_with_timestamps(viewer.id, target.id, 1000, Some(&cursor)).await.unwrap();
    assert!(!more);
    assert_eq!((edges[0].user_id, rest[0].user_id), (friend_b.id, friend_a.id));

    let ids = fx.repo.get_mutual_follower_ids(viewer.id, target.id, 10, Some(&cursor)).await.unwrap();
    assert_eq!(ids, vec![friend_a.id], "the id-only variant pages by time");
    fx.db.finish().await;
}

#[tokio::test]
async fn counters_reconcile_and_tombstones() {
    let Some(fx) = Fixture::new("follow_counters").await else { return };
    let user = create_user(&fx.users, "user").await;
    for i in 0..2 {
        let fan = create_user(&fx.users, &format!("fan{i}")).await;
        fx.make_follow(fan.id, user.id, FOLLOW_STATE_ACTIVE).await;
    }
    let other = create_user(&fx.users, "other").await;
    fx.make_follow(user.id, other.id, FOLLOW_STATE_ACTIVE).await;

    assert_eq!(fx.svc.get_follow_counts(user.id).await.unwrap(), (2, 1));
    assert_eq!(fx.svc.get_follow_counts(999_999).await.unwrap(), (0, 0));

    // Reconcile repairs drift.
    sqlx::query("UPDATE follow_counters SET followers_count = 99, following_count = -3, pending_requests_count = 4 WHERE user_id = $1")
        .bind(user.id)
        .execute(&fx.db.pool)
        .await
        .unwrap();
    fx.svc.reconcile_counters(user.id).await.unwrap();
    assert_eq!(fx.counters(user.id).await, (2, 1, 0));
    assert_eq!(fx.repo.count_following(user.id).await.unwrap(), 1);
    assert_eq!(fx.repo.count_pending_requests_for(user.id).await.unwrap(), 0);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM follow_counters").fetch_one(&fx.db.pool).await.unwrap();
    assert_eq!(fx.repo.reconcile_all_counters().await.unwrap(), rows);

    // Counter rows: in-transaction updates never start below zero; plain increments do.
    sqlx::query("DELETE FROM follow_counters WHERE user_id IN ($1, $2)")
        .bind(user.id)
        .bind(other.id)
        .execute(&fx.db.pool)
        .await
        .unwrap();
    fx.repo.remove_follow_with_counters(user.id, other.id, FOLLOW_STATE_ACTIVE).await.unwrap();
    assert_eq!(fx.counters(user.id).await, (0, 0, 0));
    assert_eq!(fx.counters(other.id).await, (0, 0, 0));
    fx.repo.increment_followers_count(424_242, -1).await.unwrap();
    assert_eq!(fx.counters(424_242).await, (-1, 0, 0));
    fx.repo.increment_pending_requests_count(424_242, 3).await.unwrap();
    assert_eq!(fx.repo.get_pending_requests_count(424_242).await.unwrap(), 3);
    let fresh = fx.repo.get_or_create_counter(515_151).await.unwrap();
    assert_eq!((fresh.user_id, fresh.followers_count, fresh.following_count), (515_151, 0, 0));

    // Tombstones: only REMOVED edges older than the cutoff go, from both tables.
    let old = create_user(&fx.users, "old").await;
    let recent = create_user(&fx.users, "recent").await;
    fx.repo.upsert_edge_dual_write(old.id, other.id, FOLLOW_STATE_REMOVED).await.unwrap();
    fx.repo.upsert_edge_dual_write(recent.id, other.id, FOLLOW_STATE_REMOVED).await.unwrap();
    fx.repo.upsert_edge_dual_write(old.id, recent.id, FOLLOW_STATE_PENDING).await.unwrap();
    fx.repo.update_edge_state(old.id, recent.id, FOLLOW_STATE_ACTIVE).await.unwrap();
    assert!(fx.repo.get_active_edge(old.id, recent.id).await.unwrap().unwrap().accepted_at.is_some());
    let ten_days_ago = Utc::now() - Duration::days(10);
    set_edge_times(&fx.db.pool, old.id, other.id, ten_days_ago).await;
    set_edge_times(&fx.db.pool, old.id, recent.id, ten_days_ago).await;
    let deleted = fx.repo.cleanup_old_tombstones(Utc::now() - Duration::days(7)).await.unwrap();
    assert_eq!(deleted, 2);
    assert_eq!(edge_states(&fx.db.pool, old.id, other.id).await, (None, None));
    fx.assert_edge(recent.id, other.id, FOLLOW_STATE_REMOVED).await;
    fx.assert_edge(old.id, recent.id, FOLLOW_STATE_ACTIVE).await;
    fx.db.finish().await;
}

#[tokio::test]
async fn follow_events_without_redis_update_counters_synchronously() {
    let Some(fx) = Fixture::new("follow_events_sync").await else { return };
    let svc = &fx.svc;

    svc.publish_follow_event(FOLLOW_EVENT_CREATED, 1, 2, FOLLOW_STATE_ACTIVE).await;
    assert_eq!(fx.counters(1).await, (0, 1, 0));
    assert_eq!(fx.counters(2).await, (1, 0, 0));

    svc.publish_follow_event(FOLLOW_EVENT_CREATED, 3, 4, FOLLOW_STATE_PENDING).await;
    assert_eq!(fx.counters(4).await, (0, 0, 1));
    assert_eq!(fx.counters(3).await, (0, 0, 0));

    svc.publish_follow_event(FOLLOW_EVENT_ACCEPTED, 3, 4, FOLLOW_STATE_ACTIVE).await;
    assert_eq!(fx.counters(3).await, (0, 1, 0));
    assert_eq!(fx.counters(4).await, (1, 0, 0));

    svc.publish_follow_event(FOLLOW_EVENT_REMOVED, 1, 2, FOLLOW_STATE_REMOVED).await;
    assert_eq!(fx.counters(1).await, (0, 0, 0));
    assert_eq!(fx.counters(2).await, (0, 0, 0));

    svc.publish_follow_event(FOLLOW_EVENT_CREATED, 5, 6, FOLLOW_STATE_PENDING).await;
    svc.publish_follow_event(FOLLOW_EVENT_DECLINED, 5, 6, FOLLOW_STATE_REMOVED).await;
    assert_eq!(fx.counters(6).await, (0, 0, 0));

    // The subscriber's handler applies the same transitions (and ignores garbage).
    svc.handle_follow_event(r#"{"type":"FOLLOW_CREATED","follower_id":7,"followee_id":8,"state":"ACTIVE","timestamp":"2026-01-04T10:05:06Z"}"#)
        .await;
    assert_eq!(fx.counters(8).await, (1, 0, 0));
    svc.handle_follow_event(r#"{"type":"FOLLOW_CREATED","follower_id":7,"followee_id":8,"state":"REMOVED"}"#).await;
    svc.handle_follow_event("not json").await;
    svc.handle_follow_event(r#"{"type":"FOLLOW_UNKNOWN","follower_id":7,"followee_id":8,"state":"ACTIVE"}"#).await;
    assert_eq!(fx.counters(7).await, (0, 1, 0));
    assert_eq!(fx.counters(8).await, (1, 0, 0));
    assert!(FollowService::start_follow_counter_subscriber(&Arc::new(fx.service_with(config()))).is_none(), "no Redis");
    fx.db.finish().await;
}
