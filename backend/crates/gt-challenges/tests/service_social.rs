//! Service tests: joining, leaving, deleting, cheering, inviting and previews (port of
//! `services/challenge_join_test.go` and `challenge_invite_test.go`).

#[macro_use]
mod common;

use std::sync::Arc;

use common::*;
use gt_challenges::dto::{ChallengePreview, ChallengeUser, InviteCandidate};
use gt_challenges::ChallengeError;
use gt_core::constants as c;
use gt_core::models::{
    FOLLOW_STATE_ACTIVE, FOLLOW_STATE_PENDING, NOTIF_ENTITY_CHALLENGE, NOTIF_TYPE_CHALLENGE_CHEER,
    NOTIF_TYPE_CHALLENGE_INVITE, NOTIF_TYPE_CHALLENGE_JOINED,
};
use serde_json::json;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn challenge_service_social() {
    let Some(db) = TestDb::new("service_social").await else {
        return;
    };
    cases!(
        db,
        "challenge service",
        join_by_code,
        join_rules,
        participant_cap_under_concurrency,
        leave_and_rejoin,
        leave,
        delete,
        cheer,
        invite_users,
        invite_again_after_leaving,
        delete_stale_invites,
        invite_candidates,
        preview_by_code,
    );
    db.finish().await;
}

fn candidate(u: &TestUser, invited: bool) -> InviteCandidate {
    InviteCandidate { user: ch_user(u), invited }
}

async fn join_by_code(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let ben = user_with_avatar(&e.pool, "ben").await;
    let created = e.svc.create(ann.id, &study_request(on(2), 7)).await.unwrap();
    let id = created.summary.id;

    let detail = e.svc.join_by_code(ben.id, &format!("  {}\t", created.invite_code.to_lowercase())).await.unwrap();
    assert_eq!(detail.summary.id, id);
    assert_eq!(detail.summary.participant_count, 2);
    assert!(!detail.summary.is_creator);
    assert!(detail.can_leave);
    assert_eq!(detail.summary.me.days_possible, 7);
    let me = participant_of(&detail, ben.id);
    assert!(me.is_me);
    assert_eq!(me.joined_on, "2026-03-09");
    assert_eq!(me.user, ch_user(&ben));

    let notifs = notifications(&e.pool, ann.id, NOTIF_TYPE_CHALLENGE_JOINED).await;
    assert_eq!(notifs.len(), 1);
    assert_eq!(notifs[0].title, "New challenger 🏁");
    assert_eq!(notifs[0].body, "ben joined “Study 2h+”");
    assert_eq!(
        notifs[0].metadata,
        json!({
            "challenge_id": id, "challenge_title": "Study 2h+", "actor_id": ben.id,
            "actor_username": "ben", "actor_avatar": ben.profile_pic,
        })
    );

    // Joining again changes nothing.
    let again = e.svc.join_by_code(ben.id, &created.invite_code).await.unwrap();
    assert_eq!(again, detail);
    assert_eq!(notifications(&e.pool, ann.id, NOTIF_TYPE_CHALLENGE_JOINED).await.len(), 1);
    assert_eq!(count(&e.pool, "challenge_participants", "challenge_id = $1", &[id]).await, 2);

    // Unknown and malformed codes.
    for code in ["ZZZZZZZZ", "bad", "", "ABCDEFG0", &format!("{}X", created.invite_code)] {
        assert_err!(e.svc.join_by_code(ben.id, code).await, ChallengeError::NotFound, "{code:?}");
    }

    // Creators are never notified about themselves.
    sqlx::query("DELETE FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2")
        .bind(id)
        .bind(ann.id)
        .execute(&e.pool)
        .await
        .unwrap();
    e.svc.join_by_code(ann.id, &created.invite_code).await.unwrap();
    assert_eq!(notifications(&e.pool, ann.id, NOTIF_TYPE_CHALLENGE_JOINED).await.len(), 1);
}

async fn join_rules(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;

    // Ended.
    let ended = seed(&ann, on(-10), 5).insert(&e.pool).await;
    join(&e.pool, &ended, &ann, on(-10)).await;
    assert_err!(e.svc.join_by_code(ben.id, &ended.invite_code).await, ChallengeError::Ended);
    let detail = e.svc.join_by_code(ann.id, &ended.invite_code).await.expect("participants still get the challenge");
    assert_eq!(detail.summary.status, "ended");

    // Full.
    let full = seed(&ann, on(1), 5).insert(&e.pool).await;
    for _ in 0..c::CHALLENGE_MAX_PARTICIPANTS {
        let member = any_user(&e.pool).await;
        join(&e.pool, &full, &member, cday()).await;
    }
    assert_err!(e.svc.join_by_code(ben.id, &full.invite_code).await, ChallengeError::Full);
    assert_eq!(
        count(&e.pool, "challenge_participants", "challenge_id = $1", &[full.id]).await,
        c::CHALLENGE_MAX_PARTICIPANTS
    );

    // Open challenge limit.
    let busy = user(&e.pool, "busy").await;
    for i in 0..c::CHALLENGE_MAX_OPEN_PER_USER {
        let challenge = seed(&ann, on(i), 3).insert(&e.pool).await;
        join(&e.pool, &challenge, &busy, cday()).await;
    }
    let open = seed(&ann, on(1), 3).insert(&e.pool).await;
    assert_err!(e.svc.join_by_code(busy.id, &open.invite_code).await, ChallengeError::LimitReached);

    // A late joiner.
    let active = seed(&ann, on(-3), 7).insert(&e.pool).await;
    join(&e.pool, &active, &ann, on(-3)).await;
    log_activity(&e.pool, &ben, "study", 5.0, on(-1)).await; // before joining: does not count
    let detail = e.svc.join_by_code(ben.id, &active.invite_code).await.unwrap();
    let me = &detail.summary.me;
    assert_eq!((me.days_possible, me.days_elapsed, me.days_met, me.total_hours), (4, 1, 0, 0.0));
    assert_eq!(participant_of(&detail, ben.id).days, "---PUUU");
    assert_eq!(me.today_status.as_deref(), Some("pending"));
}

async fn participant_cap_under_concurrency(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let challenge = seed(&ann, on(1), 5).insert(&e.pool).await;
    join(&e.pool, &challenge, &ann, cday()).await;
    for _ in 1..c::CHALLENGE_MAX_PARTICIPANTS - 5 {
        let member = any_user(&e.pool).await;
        join(&e.pool, &challenge, &member, cday()).await;
    }

    const JOINERS: usize = 12;
    let mut joiners = Vec::new();
    for i in 0..JOINERS {
        joiners.push(user(&e.pool, &format!("joiner{}", (b'a' + i as u8) as char)).await.id);
    }
    let svc = Arc::new(e.svc.clone());
    let start = Arc::new(tokio::sync::Barrier::new(JOINERS));
    let tasks: Vec<_> = joiners
        .into_iter()
        .map(|id| {
            let (svc, start, code) = (svc.clone(), start.clone(), challenge.invite_code.clone());
            tokio::spawn(async move {
                start.wait().await;
                svc.join_by_code(id, &code).await
            })
        })
        .collect();
    let (mut joined, mut full) = (0, 0);
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => joined += 1,
            Err(ChallengeError::Full) => full += 1,
            Err(err) => panic!("unexpected error: {err:#}"),
        }
    }
    assert_eq!((joined, full), (5, JOINERS - 5));
    assert_eq!(
        count(&e.pool, "challenge_participants", "challenge_id = $1", &[challenge.id]).await,
        c::CHALLENGE_MAX_PARTICIPANTS
    );
    assert_eq!(notifications(&e.pool, ann.id, NOTIF_TYPE_CHALLENGE_JOINED).await.len(), 5);
}

async fn leave_and_rejoin(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let created = e.svc.create(ann.id, &study_request(cday(), 10)).await.unwrap();
    let id = created.summary.id;
    e.svc.join_by_code(ben.id, &created.invite_code).await.unwrap();
    for i in 0..3 {
        log_activity(&e.pool, &ben, "study", 3.0, on(i)).await;
    }
    e.svc.cheer(ann.id, id, ben.id as u64).await.unwrap();
    let challenge = load_challenge(&e.pool, id).await;
    invite(&e.pool, &challenge, &ann, &ben, e.clock.now()).await;

    e.clock.set_day(on(4));
    e.svc.run_daily_job().await.unwrap();
    assert_eq!(challenge_day_dates(&e.pool, id, ben.id).await, ["2026-03-09", "2026-03-10", "2026-03-11"]);

    e.svc.leave(ben.id, id).await.unwrap();
    assert!(challenge_day_dates(&e.pool, id, ben.id).await.is_empty(), "their days go");
    assert_eq!(challenge_day_dates(&e.pool, id, ann.id).await.len(), 3, "the others' days stay");
    assert_eq!(count(&e.pool, "challenge_cheers", "challenge_id = $1", &[id]).await, 1, "cheers are kept");
    assert_eq!(
        count(&e.pool, "challenge_invites", "challenge_id = $1", &[id]).await,
        0,
        "their invite goes, so they can be invited again"
    );
    assert_err!(e.svc.get_detail(ben.id, id).await, ChallengeError::NotFound);
    assert_err!(e.svc.leave(ben.id, id).await, ChallengeError::NotFound, "leaving twice");

    // Re-joining starts a clean window from the new joining date.
    e.clock.set_day(on(5));
    let detail = e.svc.join_by_code(ben.id, &created.invite_code).await.unwrap();
    let me = participant_of(&detail, ben.id);
    assert_eq!(me.joined_on, "2026-03-14");
    assert_eq!(me.days, "-----PUUUU");
    assert_eq!(me.progress.days_met, 0);
    assert_eq!(me.progress.total_hours, 0.0);
    assert_eq!(me.progress.days_possible, 5);
    assert_eq!(notifications(&e.pool, ann.id, NOTIF_TYPE_CHALLENGE_JOINED).await.len(), 1, "no second notification");

    // Later locks never store days before the new window.
    e.clock.set_day(on(8));
    e.svc.run_daily_job().await.unwrap();
    assert_eq!(challenge_day_dates(&e.pool, id, ben.id).await, ["2026-03-14", "2026-03-15"]);
}

async fn leave(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let dan = user(&e.pool, "dan").await;
    let upcoming = seed(&ann, on(1), 5).insert(&e.pool).await;
    let ended = seed(&ann, on(-10), 5).insert(&e.pool).await;
    for challenge in [&upcoming, &ended] {
        join(&e.pool, challenge, &ann, challenge.start_date).await;
        join(&e.pool, challenge, &ben, challenge.start_date).await;
    }

    assert_err!(e.svc.leave(ann.id, upcoming.id).await, ChallengeError::CreatorCannotLeave);
    assert_err!(e.svc.leave(dan.id, upcoming.id).await, ChallengeError::NotFound);
    assert_err!(e.svc.leave(ben.id, upcoming.id + 100).await, ChallengeError::NotFound);
    assert_err!(e.svc.leave(ben.id, ended.id).await, ChallengeError::Ended);

    e.svc.leave(ben.id, upcoming.id).await.unwrap();
    assert_eq!(count(&e.pool, "challenge_participants", "challenge_id = $1", &[upcoming.id]).await, 1);
}

async fn delete(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let dan = user(&e.pool, "dan").await;
    let seeded = |start: i64, with_ben: bool| {
        let (pool, ann, ben) = (e.pool.clone(), ann.clone(), ben.clone());
        async move {
            let challenge = seed(&ann, on(start), 5).insert(&pool).await;
            join(&pool, &challenge, &ann, on(start)).await;
            if with_ben {
                join(&pool, &challenge, &ben, on(start)).await;
            }
            challenge
        }
    };
    let exists = |id: i64| {
        let pool = e.pool.clone();
        async move { count(&pool, "challenges", "id = $1", &[id]).await == 1 }
    };

    let upcoming = seeded(1, true).await;
    assert_err!(e.svc.delete(dan.id, upcoming.id).await, ChallengeError::NotFound);
    assert_err!(e.svc.delete(ann.id, upcoming.id + 100).await, ChallengeError::NotFound);
    assert_err!(e.svc.delete(ben.id, upcoming.id).await, ChallengeError::NotCreator);
    snapshot(&e.pool, &upcoming, &ben, on(1), 0.0, false).await;
    e.svc.delete(ann.id, upcoming.id).await.expect("upcoming: allowed with other participants");
    assert!(!exists(upcoming.id).await);
    assert_eq!(count(&e.pool, "challenge_participants", "challenge_id = $1", &[upcoming.id]).await, 0);
    assert_eq!(count(&e.pool, "challenge_days", "challenge_id = $1", &[upcoming.id]).await, 0);

    let active = seeded(-1, true).await;
    assert_err!(e.svc.delete(ann.id, active.id).await, ChallengeError::InProgress);
    assert!(exists(active.id).await);

    let ended = seeded(-9, true).await;
    assert_err!(e.svc.delete(ann.id, ended.id).await, ChallengeError::InProgress);

    let alone = seeded(-1, false).await;
    e.svc.delete(ann.id, alone.id).await.expect("active, the creator alone");
    assert!(!exists(alone.id).await);

    let ended_alone = seeded(-9, false).await;
    e.svc.delete(ann.id, ended_alone.id).await.unwrap();
    assert!(!exists(ended_alone.id).await);
}

async fn cheer(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user_with_avatar(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let cat = user(&e.pool, "cat").await;
    let dan = user(&e.pool, "dan").await;
    let active = seed(&ann, on(-1), 5).insert(&e.pool).await;
    let upcoming = seed(&ann, on(1), 5).insert(&e.pool).await;
    let ended = seed(&ann, on(-9), 5).insert(&e.pool).await;
    for challenge in [&active, &upcoming, &ended] {
        for u in [&ann, &ben, &cat] {
            join(&e.pool, challenge, u, challenge.start_date).await;
        }
    }
    let target = |u: &TestUser| u.id as u64;

    assert_err!(e.svc.cheer(ann.id, active.id, target(&ann)).await, ChallengeError::CannotCheerSelf);
    let (code, message) = validation(e.svc.cheer(ann.id, active.id, target(&dan)).await);
    assert_eq!(
        (code, message.as_str()),
        (c::ERR_CODE_INVALID_CHALLENGE, "user_id must be a participant of this challenge")
    );
    let (code, _) = validation(e.svc.cheer(ann.id, active.id, u64::MAX).await);
    assert_eq!(code, c::ERR_CODE_INVALID_CHALLENGE, "ids beyond int64 belong to nobody");
    assert_err!(
        e.svc.cheer(dan.id, active.id, target(&ann)).await,
        ChallengeError::NotFound,
        "only participants cheer"
    );
    assert_err!(e.svc.cheer(ann.id, active.id + 100, target(&ben)).await, ChallengeError::NotFound);
    for challenge in [&upcoming, &ended] {
        assert_err!(e.svc.cheer(ann.id, challenge.id, target(&ben)).await, ChallengeError::NotActive);
    }
    assert!(notifications(&e.pool, ben.id, NOTIF_TYPE_CHALLENGE_CHEER).await.is_empty());

    assert!(!e.svc.cheer(ann.id, active.id, target(&ben)).await.unwrap());
    let notifs = notifications(&e.pool, ben.id, NOTIF_TYPE_CHALLENGE_CHEER).await;
    assert_eq!(notifs.len(), 1);
    assert_eq!(notifs[0].title, "You got a cheer 👏");
    assert_eq!(notifs[0].body, "ann cheered you on in “Study 2h+”");
    assert_eq!(notifs[0].metadata["challenge_id"], json!(active.id));
    assert_eq!(notifs[0].metadata["actor_id"], json!(ann.id));
    assert_eq!(notifs[0].metadata["actor_avatar"], json!(ann.profile_pic));

    assert!(e.svc.cheer(ann.id, active.id, target(&ben)).await.unwrap(), "once per day");
    assert_eq!(notifications(&e.pool, ben.id, NOTIF_TYPE_CHALLENGE_CHEER).await.len(), 1);

    assert!(!e.svc.cheer(cat.id, active.id, target(&ben)).await.unwrap(), "another participant");
    assert_eq!(notifications(&e.pool, ben.id, NOTIF_TYPE_CHALLENGE_CHEER).await.len(), 2);

    let detail = e.svc.get_detail(ann.id, active.id).await.unwrap();
    assert!(participant_of(&detail, ben.id).cheered_today);
    assert!(!participant_of(&detail, cat.id).cheered_today);

    e.clock.set_day(on(1));
    assert!(!e.svc.cheer(ann.id, active.id, target(&ben)).await.unwrap(), "again the next day");
    assert_eq!(notifications(&e.pool, ben.id, NOTIF_TYPE_CHALLENGE_CHEER).await.len(), 3);
    let detail = e.svc.get_detail(cat.id, active.id).await.unwrap();
    assert!(!participant_of(&detail, ben.id).cheered_today, "Cat cheered yesterday");
}

async fn invite_users(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user_with_avatar(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let i_follow = user(&e.pool, "ifollow").await;
    let follows_me = user(&e.pool, "followsme").await;
    let stranger = user(&e.pool, "stranger").await;
    let pending = user(&e.pool, "pending").await;
    follow(&e.pool, &ann, &i_follow, FOLLOW_STATE_ACTIVE).await;
    follow(&e.pool, &follows_me, &ann, FOLLOW_STATE_ACTIVE).await;
    follow(&e.pool, &ann, &pending, FOLLOW_STATE_PENDING).await;
    follow(&e.pool, &ann, &ben, FOLLOW_STATE_ACTIVE).await;
    follow(&e.pool, &ben, &i_follow, FOLLOW_STATE_ACTIVE).await;
    let created = e.svc.create(ann.id, &study_request(on(1), 7)).await.unwrap();
    let id = created.summary.id;
    e.svc.join_by_code(ben.id, &created.invite_code).await.unwrap();
    let uid = |u: &TestUser| u.id as u64;

    // Validation.
    let (code, _) = validation(e.svc.invite(ann.id, id, &[]).await);
    assert_eq!(code, c::ERR_CODE_INVALID_CHALLENGE);
    let too_many: Vec<u64> = (1..=c::CHALLENGE_MAX_INVITES_PER_REQUEST as u64 + 1).collect();
    let (code, _) = validation(e.svc.invite(ann.id, id, &too_many).await);
    assert_eq!(code, c::ERR_CODE_INVALID_CHALLENGE);

    // Participants only.
    assert_err!(e.svc.invite(stranger.id, id, &[uid(&ann)]).await, ChallengeError::NotFound);
    assert_err!(e.svc.invite(ann.id, id + 100, &[uid(&i_follow)]).await, ChallengeError::NotFound);

    let ids = [
        uid(&follows_me),
        uid(&i_follow),
        uid(&stranger),
        uid(&pending),
        uid(&ben),
        uid(&ann),
        99999,
        uid(&i_follow),
        0,
    ];
    let (invited, skipped) = e.svc.invite(ann.id, id, &ids).await.unwrap();
    assert_eq!(invited, 2);
    assert_eq!(skipped, ids.len() as i64 - 2, "invited + skipped = number of ids");

    for u in [&i_follow, &follows_me] {
        let notifs = notifications(&e.pool, u.id, NOTIF_TYPE_CHALLENGE_INVITE).await;
        assert_eq!(notifs.len(), 1, "{}", u.username);
        assert_eq!(notifs[0].title, "Challenge invite 🏆");
        assert_eq!(notifs[0].body, "ann invited you to “Study 2h+”");
        assert_eq!(
            notifs[0].metadata,
            json!({
                "challenge_id": id, "challenge_title": "Study 2h+", "invite_code": created.invite_code,
                "actor_id": ann.id, "actor_username": "ann", "actor_avatar": ann.profile_pic,
            })
        );
    }
    for u in [&stranger, &pending, &ben] {
        assert!(notifications(&e.pool, u.id, NOTIF_TYPE_CHALLENGE_INVITE).await.is_empty(), "{}", u.username);
    }

    let (invited, skipped) = e.svc.invite(ann.id, id, &[uid(&i_follow), uid(&follows_me)]).await.unwrap();
    assert_eq!((invited, skipped), (0, 2), "an open invite is not sent again");
    let (invited, _) = e.svc.invite(ben.id, id, &[uid(&i_follow)]).await.unwrap();
    assert_eq!(invited, 0, "...by anyone");
    assert_eq!(notifications(&e.pool, i_follow.id, NOTIF_TYPE_CHALLENGE_INVITE).await.len(), 1);

    // Go binds the ids as int8 parameters: one beyond int64 fails the request (500), the
    // largest int64 is just an unknown user.
    let result = e.svc.invite(ann.id, id, &[uid(&stranger), u64::MAX]).await;
    match result {
        Err(err @ ChallengeError::Internal(_)) => {
            assert_eq!(
                format!("{err:#}"),
                "create invites: 18446744073709551615 is greater than maximum value for int8"
            );
        }
        other => panic!("expected an internal error, got {:?}", other.map(|_| "Ok")),
    }
    assert_eq!(e.svc.invite(ann.id, id, &[i64::MAX as u64]).await.unwrap(), (0, 1));
    assert_eq!(e.svc.invite(ann.id, id, &[u64::MAX, 0]).await.ok(), None);
    assert_eq!(e.svc.invite(ann.id, id, &[0, uid(&ann)]).await.unwrap(), (0, 2), "nothing left to look up");

    // Ended.
    let ended = seed(&ann, on(-9), 5).insert(&e.pool).await;
    join(&e.pool, &ended, &ann, on(-9)).await;
    assert_err!(e.svc.invite(ann.id, ended.id, &[uid(&i_follow)]).await, ChallengeError::Ended);
}

async fn invite_again_after_leaving(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user_with_avatar(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let cat = user(&e.pool, "cat").await;
    follow(&e.pool, &ann, &cat, FOLLOW_STATE_ACTIVE).await;
    follow(&e.pool, &ben, &cat, FOLLOW_STATE_ACTIVE).await;
    let created = e.svc.create(ann.id, &study_request(on(1), 7)).await.unwrap();
    let id = created.summary.id;
    let code = created.invite_code.clone();
    e.svc.join_by_code(ben.id, &code).await.unwrap();

    async fn invite_cat(svc: &gt_challenges::ChallengeService, from: i64, id: i64, cat: i64) -> i64 {
        let (invited, skipped) = svc.invite(from, id, &[cat as u64]).await.unwrap();
        assert_eq!(invited + skipped, 1);
        invited
    }
    // Whether ann's invite list marks cat as invited.
    async fn cat_invited(svc: &gt_challenges::ChallengeService, ann: i64, id: i64) -> bool {
        let users = svc.invite_candidates(ann, id, "cat", 20).await.unwrap();
        assert_eq!(users.len(), 1);
        users[0].invited
    }
    async fn join_and_leave(svc: &gt_challenges::ChallengeService, ann: i64, cat: i64, id: i64, code: &str) {
        svc.join_by_code(cat, code).await.unwrap();
        assert_eq!(invite_cat(svc, ann, id, cat).await, 0, "participants are not invited");
        svc.leave(cat, id).await.unwrap();
    }
    let svc = &e.svc;

    assert_eq!(invite_cat(svc, ann.id, id, cat.id).await, 1);
    assert!(cat_invited(svc, ann.id, id).await);
    assert_eq!(invite_cat(svc, ann.id, id, cat.id).await, 0, "an open invite is not sent again");
    assert_eq!(invite_cat(svc, ben.id, id, cat.id).await, 0, "...by anyone");

    join_and_leave(svc, ann.id, cat.id, id, &code).await;
    assert!(!cat_invited(svc, ann.id, id).await, "leaving removed the invite");
    assert_eq!(invite_cat(svc, ann.id, id, cat.id).await, 1, "the same person can invite again");
    assert!(cat_invited(svc, ann.id, id).await);
    assert_eq!(invite_cat(svc, ben.id, id, cat.id).await, 0, "the new invite is open");
    let notifs = notifications(&e.pool, cat.id, NOTIF_TYPE_CHALLENGE_INVITE).await;
    assert_eq!(notifs.len(), 2, "the new invite is notified");
    assert_eq!(notifs[1].body, "ann invited you to “Study 2h+”");
    assert_eq!(notifs[1].metadata["invite_code"], json!(code));

    join_and_leave(svc, ann.id, cat.id, id, &code).await;
    assert_eq!(invite_cat(svc, ben.id, id, cat.id).await, 1, "anyone can invite again");
    let notifs = notifications(&e.pool, cat.id, NOTIF_TYPE_CHALLENGE_INVITE).await;
    assert_eq!(notifs.len(), 3);
    assert_eq!(notifs[2].body, "ben invited you to “Study 2h+”");
    assert_eq!(
        notifications(&e.pool, ann.id, NOTIF_TYPE_CHALLENGE_JOINED).await.len(),
        2,
        "one joined notification per joiner, however often they join"
    );
}

async fn delete_stale_invites(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let cat = user(&e.pool, "cat").await;
    let dan = user(&e.pool, "dan").await;
    follow(&e.pool, &ann, &cat, FOLLOW_STATE_ACTIVE).await;
    follow(&e.pool, &ann, &dan, FOLLOW_STATE_ACTIVE).await;
    let challenge = seed(&ann, on(1), 5).insert(&e.pool).await;
    join(&e.pool, &challenge, &ann, cday()).await;
    // As left behind before leaving removed invites: cat joined with hers and left; dan has
    // not answered his yet.
    let invited_at = e.clock.now();
    for u in [&cat, &dan] {
        invite(&e.pool, &challenge, &ann, u, invited_at).await;
    }
    sqlx::query(
        "INSERT INTO notification_dedupes (user_id, actor_id, type, entity_type, entity_key, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(ann.id)
    .bind(cat.id)
    .bind(NOTIF_TYPE_CHALLENGE_JOINED)
    .bind(NOTIF_ENTITY_CHALLENGE)
    .bind(challenge.id.to_string())
    .bind(invited_at + chrono::Duration::hours(1))
    .execute(&e.pool)
    .await
    .unwrap();
    let (logs, _guard) = LogCapture::start();

    e.svc.delete_stale_invites().await.unwrap();
    let users = e.svc.invite_candidates(ann.id, challenge.id, "", 20).await.unwrap();
    assert_eq!(users, vec![candidate(&cat, false), candidate(&dan, true)]);
    let entries = logs.with_message("Stale challenge invites deleted");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].fields["deleted_count"], "1");

    e.svc.delete_stale_invites().await.unwrap();
    assert_eq!(logs.count("Stale challenge invites deleted"), 1, "nothing deleted, nothing logged");

    let failing = e.failing(fail(r"DELETE FROM challenge_invites i")).await;
    let err = failing.delete_stale_invites().await.unwrap_err();
    assert!(injected(&err), "{err:#}");
}

async fn invite_candidates(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let stranger = user(&e.pool, "stranger").await;
    let amy = user_with_avatar(&e.pool, "amy").await;
    let abe = user(&e.pool, "abe").await;
    follow(&e.pool, &ann, &amy, FOLLOW_STATE_ACTIVE).await;
    follow(&e.pool, &abe, &ann, FOLLOW_STATE_ACTIVE).await;
    follow(&e.pool, &ann, &ben, FOLLOW_STATE_ACTIVE).await;
    let challenge = seed(&ann, on(1), 5).insert(&e.pool).await;
    join(&e.pool, &challenge, &ann, cday()).await;
    join(&e.pool, &challenge, &ben, cday()).await;
    invite(&e.pool, &challenge, &ben, &abe, e.clock.now()).await;
    let id = challenge.id;

    assert_err!(e.svc.invite_candidates(stranger.id, id, "", 20).await, ChallengeError::NotFound);
    assert_err!(e.svc.invite_candidates(ann.id, id + 100, "", 20).await, ChallengeError::NotFound);

    let users = e.svc.invite_candidates(ann.id, id, "", 0).await.unwrap();
    assert_eq!(users, vec![candidate(&abe, true), candidate(&amy, false)], "ben takes part already");

    let users = e.svc.invite_candidates(ann.id, id, "  AM ", 20).await.unwrap();
    assert_eq!(users, vec![candidate(&amy, false)], "trimmed, case-insensitive prefix");

    let users = e.svc.invite_candidates(ann.id, id, &"a".repeat(c::USERNAME_MAX_LENGTH + 1), 20).await.unwrap();
    assert!(users.is_empty(), "no username is that long");

    assert_eq!(e.svc.invite_candidates(ann.id, id, "", 1).await.unwrap().len(), 1);

    // At most 50.
    for i in 0..=c::CHALLENGE_CANDIDATES_MAX {
        let friend = user(&e.pool, &format!("friend{i:02}")).await;
        follow(&e.pool, &ann, &friend, FOLLOW_STATE_ACTIVE).await;
    }
    let users = e.svc.invite_candidates(ann.id, id, "friend", 500).await.unwrap();
    assert_eq!(users.len() as i64, c::CHALLENGE_CANDIDATES_MAX);
}

async fn preview_by_code(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user_with_avatar(&e.pool, "ann").await;
    let outsider = user(&e.pool, "outsider").await;
    let challenge = seed(&ann, on(2), 7).insert(&e.pool).await;
    join(&e.pool, &challenge, &ann, cday()).await;
    let mut members = Vec::new();
    for i in 0..6 {
        let member = user(&e.pool, &format!("member{i}")).await;
        join(&e.pool, &challenge, &member, cday()).await;
        members.push(member);
    }

    let preview =
        e.svc.preview_by_code(outsider.id, &format!(" {}", challenge.invite_code.to_lowercase())).await.unwrap();
    let expected_preview: Vec<ChallengeUser> =
        [&ann, &members[0], &members[1], &members[2], &members[3]].into_iter().map(ch_user).collect();
    assert_eq!(
        preview,
        ChallengePreview {
            id: challenge.id,
            title: "Study 2h+".into(),
            activity: "study".into(),
            goal_type: "at_least".into(),
            target_hours: 2.0,
            start_date: "2026-03-11".into(),
            end_date: "2026-03-17".into(),
            duration_days: 7,
            status: "upcoming".into(),
            finalized: false,
            participant_count: 7,
            max_participants: 50,
            creator: ch_user(&ann),
            participants_preview: expected_preview,
            is_participant: false,
            can_join: true,
            join_blocked_reason: None,
        }
    );

    let preview = e.svc.preview_by_code(members[5].id, &challenge.invite_code).await.unwrap();
    assert!(preview.is_participant);
    assert!(!preview.can_join);
    assert_eq!(preview.join_blocked_reason, None);

    for code in ["ZZZZZZZZ", "nope"] {
        assert_err!(e.svc.preview_by_code(outsider.id, code).await, ChallengeError::NotFound);
    }

    let blocked = |code: String, reason: &'static str| {
        let svc = &e.svc;
        let outsider = outsider.id;
        async move {
            let preview = svc.preview_by_code(outsider, &code).await.unwrap();
            assert!(!preview.can_join);
            assert_eq!(preview.join_blocked_reason.as_deref(), Some(reason));
            preview
        }
    };

    // Ended.
    let ended = seed(&ann, on(-9), 5).finalized(e.clock.now()).insert(&e.pool).await;
    join(&e.pool, &ended, &ann, on(-9)).await;
    let preview = blocked(ended.invite_code.clone(), "ended").await;
    assert!(preview.finalized);
    assert_eq!(preview.status, "ended");

    // Full.
    let full = seed(&ann, on(1), 5).insert(&e.pool).await;
    for _ in 0..c::CHALLENGE_MAX_PARTICIPANTS {
        let member = any_user(&e.pool).await;
        join(&e.pool, &full, &member, cday()).await;
    }
    let preview = blocked(full.invite_code.clone(), "full").await;
    assert_eq!(preview.participants_preview.len() as i64, c::CHALLENGE_PREVIEW_PARTICIPANTS);
    assert_eq!(preview.participant_count, c::CHALLENGE_MAX_PARTICIPANTS);

    // Open challenge limit.
    for _ in 0..c::CHALLENGE_MAX_OPEN_PER_USER {
        let other = seed(&ann, on(1), 5).insert(&e.pool).await;
        join(&e.pool, &other, &outsider, cday()).await;
    }
    blocked(challenge.invite_code.clone(), "limit").await;
}
