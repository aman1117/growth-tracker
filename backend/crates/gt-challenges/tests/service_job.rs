//! Service tests: the daily job and failure handling (port of `services/challenge_job_test.go`
//! and `challenge_failures_test.go`; Go's GORM fault injection becomes statement-matching
//! PostgreSQL views and triggers, see `common`).

#[macro_use]
mod common;

use std::time::Duration as StdDuration;

use common::*;
use gt_challenges::dto::{ChallengeDay, ChallengeProgress};
use gt_challenges::service::locking::EndedResult;
use gt_challenges::{ChallengeError, ChallengeService};
use gt_core::models::{
    CRON_JOB_CHALLENGE_DAILY, CRON_JOB_STATUS_COMPLETED, CRON_JOB_STATUS_FAILED, CRON_JOB_STATUS_RUNNING,
    FOLLOW_STATE_ACTIVE, NOTIF_TYPE_CHALLENGE_ENDED, NOTIF_TYPE_CHALLENGE_JOINED,
};
use serde_json::json;
use sqlx::PgPool;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn challenge_service_job() {
    let Some(db) = TestDb::new("service_job").await else {
        return;
    };
    cases!(
        db,
        "challenge service",
        run_daily_job,
        run_daily_job_at_most_ranking,
        lock_and_finalize_are_idempotent,
        update_job_log_failure,
        query_failures,
        command_failures,
        loading_after_a_successful_write_fails,
        deleting_fails,
        challenge_deleted_before_the_join_locks_it,
        daily_job_failures,
        notification_failures_do_not_fail_requests,
    );
    db.finish().await;
}

// ==================== Statements (Go: the failXxx predicates) ====================

const LIST_FOR_USER: Fault = fail(r"UNION ALL");
const LIST_PARTICIPANTS: Fault = fail(r"JOIN users u ON u\.id = p\.user_id");
const LOCKED_TOTALS: Fault = fail(r"FILTER \(WHERE d\.met\)");
const ACTIVITY_DAYS: Fault = fail(r"FILTER \(WHERE a\.name = c\.activity\)");
const LIST_USER_DAYS: Fault = fail(r"FROM challenge_days WHERE user_id = \$1 AND challenge_id = ANY");
const LIST_DAYS: Fault = fail(r"FROM challenge_days WHERE challenge_id = \$1 ORDER BY user_id");
const CHEERED_USER_IDS: Fault = fail(r"FROM challenge_cheers");
const CREATE_CHEER: Fault = fail(r"INSERT INTO challenge_cheers");
const FIND_BY_CODE: Fault = fail(r"FROM challenges WHERE invite_code");
const FIND_PARTICIPANT: Fault = fail(r"FROM challenge_participants WHERE challenge_id = \$1 AND user_id = \$2");
const COUNT_OPEN: Fault = fail(r"JOIN challenges c ON c\.id = challenge_participants\.challenge_id");
const LOCK_USER: Fault = fail(r"FOR NO KEY UPDATE");
const ADD_PARTICIPANT: Fault = fail(r"INSERT INTO challenge_participants");
const CREATE_CHALLENGE: Fault = fail(r"INSERT INTO challenges ");
const REMOVE_PARTICIPANT: Fault = fail(r"DELETE FROM challenge_participants");
const DELETE_CHALLENGE: Fault = fail(r"DELETE FROM challenges WHERE id");
const CREATE_INVITES: Fault = fail(r"INSERT INTO challenge_invites");
const INVITE_CANDIDATES: Fault = fail(r"ESCAPE");
const INSERT_DAYS: Fault = fail(r"INSERT INTO challenge_days");
const SET_LOCKED_THROUGH: Fault = fail(r"SET locked_through");
const MARK_FINALIZED: Fault = fail(r"SET finalized_at");
const SAVE_FINAL_RESULTS: Fault = fail(r"UPDATE challenge_participants AS p");
const IDS_TO_LOCK: Fault = fail(r"start_date <= \$1");
const IDS_TO_FINALIZE: Fault = fail(r"locked_through >= end_date");
/// `find_by_id` and the row lock of `lock_challenge`.
const CHALLENGE_BY_ID: Fault = fail(r"FROM challenges WHERE id = \$1");
/// `count_participants` (and not `find_participant`).
const COUNT_PARTICIPANTS: Fault = fail(r"count\(\*\) FROM challenge_participants WHERE challenge_id = \$1$");

// ==================== Helpers ====================

/// A participant's locked days as `date:met|missed:hours`.
async fn locked_days(pool: &PgPool, challenge_id: i64, user_id: i64) -> Vec<String> {
    let rows: Vec<(chrono::NaiveDate, bool, f64)> = sqlx::query_as(
        "SELECT day_date, met, hours::float8 FROM challenge_days WHERE challenge_id = $1 AND user_id = $2 ORDER BY day_date",
    )
    .bind(challenge_id)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(date, met, hours)| format!("{}:{}:{hours}", ymd(date), if met { "met" } else { "missed" }))
        .collect()
}

/// The stored final results of a challenge's participants by user id:
/// `(user_id, rank, days met, hours, completed)`.
async fn final_results(
    pool: &PgPool,
    challenge_id: i64,
) -> Vec<(i64, Option<i64>, Option<i64>, Option<f64>, Option<bool>)> {
    sqlx::query_as(
        "SELECT user_id, final_rank::bigint, final_days_met::bigint, final_total_hours::float8, completed \
         FROM challenge_participants WHERE challenge_id = $1 ORDER BY user_id",
    )
    .bind(challenge_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn assert_injected<T>(result: Result<T, ChallengeError>, name: &str) {
    match result {
        Err(err) => assert!(injected(&err), "{name}: expected the injected failure, got {err:#}"),
        Ok(_) => panic!("{name}: expected the injected failure, got Ok"),
    }
}

// ==================== Daily job ====================

// Study 2h+ from S to S+4. Ann (the creator) joined before the start, Ben on S+2.
async fn run_daily_job(db: &TestDb) {
    let mut e = Ch::new(db, on(3));
    e.svc = e.svc.clone().with_instance_id("job-test");
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let c = seed(&ann, cday(), 5).insert(&e.pool).await;
    join(&e.pool, &c, &ann, on(-1)).await;
    join(&e.pool, &c, &ben, on(2)).await;
    let upcoming = seed(&ann, on(10), 5).insert(&e.pool).await;
    join(&e.pool, &upcoming, &ann, cday()).await;
    let starts_today = seed(&ann, on(3), 10).insert(&e.pool).await;
    join(&e.pool, &starts_today, &ann, on(3)).await;

    log_activity(&e.pool, &ann, "study", 2.0, cday()).await;
    log_activity(&e.pool, &ann, "study", 1.0, on(1)).await;
    log_activity(&e.pool, &ann, "sleep", 8.0, on(1)).await;
    log_activity(&e.pool, &ann, "study", 3.0, on(2)).await;
    log_activity(&e.pool, &ann, "study", 2.0, on(3)).await;
    log_activity(&e.pool, &ann, "study", 2.5, on(4)).await;
    log_activity(&e.pool, &ben, "study", 5.0, on(1)).await; // before Ben joined
    log_activity(&e.pool, &ben, "study", 2.0, on(2)).await;
    log_activity(&e.pool, &ben, "study", 4.0, on(4)).await;

    // On S+3, S and S+1 can no longer change.
    e.svc.run_daily_job().await.unwrap();
    assert_eq!(locked_days(&e.pool, c.id, ann.id).await, ["2026-03-09:met:2", "2026-03-10:missed:1"]);
    assert!(locked_days(&e.pool, c.id, ben.id).await.is_empty(), "nothing before Ben's window");
    let got = load_challenge(&e.pool, c.id).await;
    assert_eq!(got.locked_through.map(ymd).as_deref(), Some("2026-03-10"));
    assert_eq!(got.finalized_at, None);
    assert_eq!(load_challenge(&e.pool, upcoming.id).await.locked_through, None);
    assert_eq!(load_challenge(&e.pool, starts_today.id).await.locked_through, None);
    let (logged, locked_at): (bool, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT logged, locked_at FROM challenge_days WHERE challenge_id = $1 AND user_id = $2 AND day_date = $3",
    )
    .bind(c.id)
    .bind(ann.id)
    .bind(on(1))
    .fetch_one(&e.pool)
    .await
    .unwrap();
    assert!(logged, "something was logged that day");
    assert_eq!(locked_at, e.clock.now());

    let logs = cron_job_logs(&e.pool, CRON_JOB_CHALLENGE_DAILY).await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].status, CRON_JOB_STATUS_COMPLETED);
    assert_eq!(ymd(logs[0].job_date), "2026-03-12");
    assert_eq!(logs[0].instance_id, "job-test");
    assert_eq!(logs[0].users_count, 1, "challenges processed");
    assert_eq!(logs[0].error, "");
    assert!(logs[0].completed_at.is_some());

    // Editing a locked day changes nothing.
    sqlx::query(
        "UPDATE activities SET duration_hours = 4 WHERE user_id = $1 AND activity_date = $2 AND name = 'study'",
    )
    .bind(ann.id)
    .bind(on(1))
    .execute(&e.pool)
    .await
    .unwrap();
    let detail = e.svc.get_detail(ann.id, c.id).await.unwrap();
    assert_eq!(
        detail.my_days.as_ref().unwrap()[1],
        ChallengeDay { date: "2026-03-10".into(), hours: Some(1.0), status: "missed".into(), locked: true }
    );

    // A second run on the same day (another replica) does nothing.
    let (capture, guard) = LogCapture::start();
    e.svc.run_daily_job().await.unwrap();
    drop(guard);
    assert_eq!(cron_job_logs(&e.pool, CRON_JOB_CHALLENGE_DAILY).await.len(), 1);
    let skipped = capture.with_message("Challenge job already claimed by another instance, skipping");
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0].fields["claimed_by"], "job-test");

    // Without job logs a re-run is still harmless.
    let unclaimed = e.service(&e.pool, None, Some(&e.pool));
    unclaimed.run_daily_job().await.unwrap();
    assert_eq!(locked_days(&e.pool, c.id, ann.id).await.len(), 2);

    // S+4..S+8 were missed: the next run catches up and finalizes.
    e.clock.set_day(on(9));
    e.svc.run_daily_job().await.unwrap();
    assert_eq!(
        locked_days(&e.pool, c.id, ann.id).await,
        ["2026-03-09:met:2", "2026-03-10:missed:1", "2026-03-11:met:3", "2026-03-12:met:2", "2026-03-13:met:2.5"]
    );
    assert_eq!(
        locked_days(&e.pool, c.id, ben.id).await,
        ["2026-03-11:met:2", "2026-03-12:missed:0", "2026-03-13:met:4"]
    );
    let got = load_challenge(&e.pool, c.id).await;
    assert_eq!(got.locked_through.map(ymd).as_deref(), Some("2026-03-13"));
    assert_eq!(got.finalized_at, Some(e.clock.now()));
    assert_eq!(
        load_challenge(&e.pool, starts_today.id).await.locked_through.map(ymd).as_deref(),
        Some("2026-03-16"),
        "through today-2"
    );
    let logs = cron_job_logs(&e.pool, CRON_JOB_CHALLENGE_DAILY).await;
    assert_eq!(logs.len(), 2);
    assert_eq!(logs[1].users_count, 3, "two challenges locked, one finalized");

    assert_eq!(
        final_results(&e.pool, c.id).await,
        vec![
            (ann.id, Some(1), Some(4), Some(10.5), Some(true)), // the locked hours, not the later edit; 4 of 5 days
            (ben.id, Some(2), Some(2), Some(6.0), Some(false)), // 2 of 3 days
        ]
    );

    let ann_ended = notifications(&e.pool, ann.id, NOTIF_TYPE_CHALLENGE_ENDED).await;
    assert_eq!(ann_ended.len(), 1);
    assert_eq!(ann_ended[0].title, "Challenge complete 🎉");
    assert_eq!(ann_ended[0].body, "“Study 2h+” is over: you finished #1 with 4/5 days.");
    assert_eq!(
        ann_ended[0].metadata,
        json!({
            "challenge_id": c.id, "challenge_title": "Study 2h+", "rank": 1,
            "days_met": 4, "days_possible": 5, "completed": true,
        })
    );
    let ben_ended = notifications(&e.pool, ben.id, NOTIF_TYPE_CHALLENGE_ENDED).await;
    assert_eq!(ben_ended.len(), 1);
    assert_eq!(ben_ended[0].title, "Challenge ended");
    assert_eq!(ben_ended[0].body, "“Study 2h+” is over: you finished #2 with 2/3 days.");

    let detail = e.svc.get_detail(ben.id, c.id).await.unwrap();
    assert!(detail.summary.finalized);
    assert_eq!(detail.summary.status, "ended");
    assert_eq!(
        detail.summary.me,
        ChallengeProgress {
            rank: Some(2),
            days_met: 2,
            days_elapsed: 3,
            days_possible: 3,
            current_streak: 1,
            total_hours: 6.0,
            completed: Some(false),
            ..Default::default()
        }
    );
    assert_eq!(participant_of(&detail, ben.id).days, "--MXM");

    // Later runs leave finalized challenges alone and notify nobody twice.
    e.clock.set_day(on(10));
    e.svc.run_daily_job().await.unwrap();
    unclaimed.run_daily_job().await.unwrap();
    assert_eq!(notifications(&e.pool, ann.id, NOTIF_TYPE_CHALLENGE_ENDED).await.len(), 1);
    assert_eq!(notifications(&e.pool, ben.id, NOTIF_TYPE_CHALLENGE_ENDED).await.len(), 1);
    assert_eq!(load_challenge(&e.pool, c.id).await.finalized_at, got.finalized_at);
    assert_eq!(load_challenge(&e.pool, starts_today.id).await.locked_through.map(ymd).as_deref(), Some("2026-03-17"));
}

// Reels at most 1h over 3 days: fewer hours rank higher and equal results share a rank.
async fn run_daily_job_at_most_ranking(db: &TestDb) {
    let e = Ch::new(db, on(5));
    let kim = user(&e.pool, "kim").await;
    let ned = user(&e.pool, "ned").await;
    let lee = user(&e.pool, "lee").await;
    let mo = user(&e.pool, "mo").await;
    let c = seed(&kim, cday(), 3).goal("Study 2h+", "reels", "at_most", 1.0).insert(&e.pool).await;
    for u in [&kim, &ned, &lee, &mo] {
        join(&e.pool, &c, u, cday()).await;
    }
    for i in 0..3 {
        log_activity(&e.pool, &kim, "reels", 0.5, on(i)).await;
        log_activity(&e.pool, &ned, "reels", 0.5, on(i)).await;
        log_activity(&e.pool, &lee, "reels", 0.5, on(i)).await;
        log_activity(&e.pool, &mo, "study", 1.0, on(i)).await; // logged, but no reels: met with 0 hours
    }
    log_activity(&e.pool, &lee, "reels", 1.0, on(1)).await; // 1.5 hours: missed

    e.svc.run_daily_job().await.unwrap();

    let rows = e.svc.repository().conn().await.unwrap().list_participants(&[c.id]).await.unwrap();
    let mut got: Vec<(String, i64, i64, f64, bool)> = rows
        .into_iter()
        .map(|r| {
            (
                r.username,
                r.final_rank.unwrap(),
                r.final_days_met.unwrap(),
                r.final_total_hours.unwrap(),
                r.completed.unwrap(),
            )
        })
        .collect();
    got.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        got,
        vec![
            ("kim".into(), 2, 3, 1.5, true),
            ("lee".into(), 4, 2, 2.5, false),
            ("mo".into(), 1, 3, 0.0, true),
            ("ned".into(), 2, 3, 1.5, true),
        ]
    );
    let lee_ended = notifications(&e.pool, lee.id, NOTIF_TYPE_CHALLENGE_ENDED).await;
    assert_eq!(lee_ended.len(), 1);
    assert_eq!(lee_ended[0].body, "“Study 2h+” is over: you finished #4 with 2/3 days.");
}

async fn lock_and_finalize_are_idempotent(db: &TestDb) {
    let e = Ch::new(db, on(9));
    let ann = user(&e.pool, "ann").await;
    let c = seed(&ann, cday(), 3).insert(&e.pool).await;
    join(&e.pool, &c, &ann, cday()).await;

    e.svc.lock_challenge_days(c.id, on(7)).await.unwrap();
    assert_eq!(locked_days(&e.pool, c.id, ann.id).await.len(), 3);
    e.svc.lock_challenge_days(c.id, on(7)).await.expect("already locked");
    assert_eq!(locked_days(&e.pool, c.id, ann.id).await.len(), 3);

    let (finalized, results) = e.svc.finalize_challenge(c.id).await.unwrap().expect("finalized");
    assert_eq!(finalized.id, c.id);
    assert_eq!(
        results,
        vec![EndedResult { user_id: ann.id, rank: 1, days_met: 0, days_possible: 3, completed: false }]
    );
    assert!(e.svc.finalize_challenge(c.id).await.unwrap().is_none(), "finalized already");

    let done = seed(&ann, cday(), 3).finalized(e.clock.now()).insert(&e.pool).await;
    join(&e.pool, &done, &ann, cday()).await;
    e.svc.lock_challenge_days(done.id, on(7)).await.unwrap();
    assert!(locked_days(&e.pool, done.id, ann.id).await.is_empty(), "finalized challenges are never locked again");

    let not_locked = seed(&ann, cday(), 3).insert(&e.pool).await;
    assert!(e.svc.finalize_challenge(not_locked.id).await.unwrap().is_none(), "not every day is locked");

    let err = e.svc.lock_challenge_days(c.id + 100, on(7)).await.unwrap_err();
    assert_eq!(err.to_string(), "challenge not found");
}

/// Go `TestChallengeService_UpdateJobLog`: a failing update is only logged.
async fn update_job_log_failure(db: &TestDb) {
    let e = Ch::new(db, on(3));
    let ann = user(&e.pool, "ann").await;
    let c = seed(&ann, cday(), 5).insert(&e.pool).await;
    join(&e.pool, &c, &ann, cday()).await;
    let job_logs = db.faulty_pool(fail(r"ON CONFLICT \(id\)")).await;
    let svc = e.service(&e.pool, Some(&job_logs), Some(&e.pool));

    let (logs, _guard) = LogCapture::start();
    svc.run_daily_job().await.expect("the failure is only logged");
    assert_eq!(logs.count("Failed to update the challenge job log"), 1);
    let stored = cron_job_logs(&e.pool, CRON_JOB_CHALLENGE_DAILY).await;
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].status, CRON_JOB_STATUS_RUNNING);
    assert!(load_challenge(&e.pool, c.id).await.locked_through.is_some());

    // Without a job log repository nothing is claimed or updated.
    e.clock.set_day(on(4));
    e.service(&e.pool, None, None).run_daily_job().await.unwrap();
    assert_eq!(cron_job_logs(&e.pool, CRON_JOB_CHALLENGE_DAILY).await.len(), 1);
}

// ==================== Failures ====================

async fn query_failures(db: &TestDb) {
    let e = Ch::new(db, on(3));
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let outsider = user(&e.pool, "outsider").await;
    let active = seed(&ann, cday(), 7).insert(&e.pool).await;
    join(&e.pool, &active, &ann, cday()).await;
    join(&e.pool, &active, &ben, cday()).await;
    follow(&e.pool, &ann, &outsider, FOLLOW_STATE_ACTIVE).await;
    let (id, code) = (active.id, active.invite_code.clone());

    let tests: [(&str, Fault, u8); 20] = [
        ("list: challenges", LIST_FOR_USER, 0),
        ("list: participants", LIST_PARTICIPANTS, 0),
        ("list: locked totals", LOCKED_TOTALS, 0),
        ("list: activity", ACTIVITY_DAYS, 0),
        ("list: my days", LIST_USER_DAYS, 0),
        ("detail: challenge", CHALLENGE_BY_ID, 1),
        ("detail: participants", LIST_PARTICIPANTS, 1),
        ("detail: locked days", LIST_DAYS, 1),
        ("detail: activity", ACTIVITY_DAYS, 1),
        ("detail: cheers", CHEERED_USER_IDS, 1),
        ("candidates: challenge", CHALLENGE_BY_ID, 2),
        ("candidates: participant", FIND_PARTICIPANT, 2),
        ("candidates: users", INVITE_CANDIDATES, 2),
        ("preview: code", FIND_BY_CODE, 3),
        ("preview: participants", LIST_PARTICIPANTS, 3),
        ("preview: open challenges", COUNT_OPEN, 3),
        ("cheer: participants", LIST_PARTICIPANTS, 4),
        ("cheer: store", CREATE_CHEER, 4),
        ("invite: challenge", CHALLENGE_BY_ID, 5),
        ("invite: store", CREATE_INVITES, 5),
    ];
    for (name, fault, call) in tests {
        let svc = e.failing(fault).await;
        match call {
            0 => assert_injected(svc.list(ann.id).await, name),
            1 => assert_injected(svc.get_detail(ann.id, id).await, name),
            2 => assert_injected(svc.invite_candidates(ann.id, id, "", 20).await, name),
            3 => assert_injected(svc.preview_by_code(outsider.id, &code).await, name),
            4 => assert_injected(svc.cheer(ann.id, id, ben.id as u64).await, name),
            _ => assert_injected(svc.invite(ann.id, id, &[outsider.id as u64]).await, name),
        }
    }
    assert_eq!(count(&e.pool, "challenge_cheers", "true", &[]).await, 0);
    assert_eq!(count(&e.pool, "challenge_invites", "true", &[]).await, 0);
}

async fn command_failures(db: &TestDb) {
    let e = Ch::new(db, on(3));
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let joiner = user(&e.pool, "joiner").await;
    let active = seed(&ann, cday(), 7).insert(&e.pool).await;
    join(&e.pool, &active, &ann, cday()).await;
    join(&e.pool, &active, &ben, cday()).await;
    let (id, code) = (active.id, active.invite_code.clone());

    let tests: [(&str, Fault, u8); 15] = [
        ("create: lock user", LOCK_USER, 0),
        ("create: open challenges", COUNT_OPEN, 0),
        ("create: challenge", CREATE_CHALLENGE, 0),
        ("create: participant", ADD_PARTICIPANT, 0),
        ("join: code", FIND_BY_CODE, 1),
        ("join: lock", CHALLENGE_BY_ID, 1),
        ("join: participant", FIND_PARTICIPANT, 1),
        ("join: count", COUNT_PARTICIPANTS, 1),
        ("join: lock user", LOCK_USER, 1),
        ("join: open challenges", COUNT_OPEN, 1),
        ("join: store", ADD_PARTICIPANT, 1),
        ("leave: participant", FIND_PARTICIPANT, 2),
        ("leave: remove", REMOVE_PARTICIPANT, 2),
        ("delete: participant", FIND_PARTICIPANT, 3),
        ("delete: count", COUNT_PARTICIPANTS, 3),
    ];
    for (name, fault, call) in tests {
        let svc = e.failing(fault).await;
        match call {
            0 => assert_injected(svc.create(joiner.id, &study_request(on(3), 3)).await, name),
            1 => assert_injected(svc.join_by_code(joiner.id, &code).await, name),
            2 => assert_injected(svc.leave(ben.id, id).await, name),
            _ => assert_injected(svc.delete(ann.id, id).await, name),
        }
    }
    assert_eq!(count(&e.pool, "challenges", "true", &[]).await, 1, "nothing was created");
    assert_eq!(count(&e.pool, "challenge_participants", "true", &[]).await, 2, "nobody joined or left");
}

async fn loading_after_a_successful_write_fails(db: &TestDb) {
    let e = Ch::new(db, on(3));
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let joiner = user(&e.pool, "joiner").await;
    let active = seed(&ann, cday(), 7).insert(&e.pool).await;
    join(&e.pool, &active, &ann, cday()).await;
    join(&e.pool, &active, &ben, cday()).await;
    let (logs, _guard) = LogCapture::start();

    let svc = e.failing(LIST_DAYS).await;
    assert_injected(svc.create(joiner.id, &study_request(on(3), 3)).await, "create");
    assert_eq!(count(&e.pool, "challenges", "true", &[]).await, 2, "the challenge itself was created");

    assert_injected(svc.join_by_code(joiner.id, &active.invite_code).await, "join");
    assert_eq!(count(&e.pool, "challenge_participants", "challenge_id = $1", &[active.id]).await, 3);
    assert_eq!(logs.count("Challenge joined"), 1, "the join is logged");
    assert_eq!(logs.count("Challenge joined notification skipped: loading the challenge failed after the join"), 1);
    assert!(notifications(&e.pool, ann.id, NOTIF_TYPE_CHALLENGE_JOINED).await.is_empty());
}

async fn deleting_fails(db: &TestDb) {
    let e = Ch::new(db, on(3));
    let ann = user(&e.pool, "ann").await;
    let alone = seed(&ann, on(4), 3).insert(&e.pool).await;
    join(&e.pool, &alone, &ann, on(3)).await;
    assert_injected(e.failing(DELETE_CHALLENGE).await.delete(ann.id, alone.id).await, "delete");
    assert_eq!(count(&e.pool, "challenges", "id = $1", &[alone.id]).await, 1);
}

/// Waits until another connection waits for a row lock in the test database.
async fn wait_for_lock_waiter(pool: &PgPool) {
    for _ in 0..500 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        if waiting > 0 {
            return;
        }
        tokio::time::sleep(StdDuration::from_millis(10)).await;
    }
    panic!("nobody waited for the row lock");
}

/// Go: a concurrent delete between resolving the code and locking the challenge (there a GORM
/// hook; here a real concurrent transaction).
async fn challenge_deleted_before_the_join_locks_it(db: &TestDb) {
    let e = Ch::new(db, on(3));
    let ann = user(&e.pool, "ann").await;
    let joiner = user(&e.pool, "joiner").await;
    let gone = seed(&ann, on(4), 3).insert(&e.pool).await;
    join(&e.pool, &gone, &ann, on(3)).await;

    let mut deleter = e.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM challenges WHERE id = $1 FOR UPDATE")
        .bind(gone.id)
        .execute(&mut *deleter)
        .await
        .unwrap();
    let svc = e.svc.clone();
    let code = gone.invite_code.clone();
    let join = tokio::spawn(async move { svc.join_by_code(joiner.id, &code).await });
    wait_for_lock_waiter(&e.pool).await;
    sqlx::query("DELETE FROM challenges WHERE id = $1").bind(gone.id).execute(&mut *deleter).await.unwrap();
    deleter.commit().await.unwrap();
    assert_err!(join.await.unwrap(), ChallengeError::NotFound);
}

/// One challenge to lock (S..S+4, today S+3) and one to finalize.
async fn job_setup(e: &Ch<'_>) -> (gt_core::models::Challenge, gt_core::models::Challenge) {
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let to_lock = seed(&ann, cday(), 5).insert(&e.pool).await;
    join(&e.pool, &to_lock, &ann, cday()).await;
    let to_finalize = seed(&ann, on(-6), 3).locked(on(-4)).insert(&e.pool).await;
    join(&e.pool, &to_finalize, &ann, on(-6)).await;
    join(&e.pool, &to_finalize, &ben, on(-6)).await;
    (to_lock, to_finalize)
}

async fn daily_job_failures(db: &TestDb) {
    // (name, fault, locked, finalized, processed)
    let tests: [(&str, Fault, bool, bool, i64); 12] = [
        ("listing challenges to lock", IDS_TO_LOCK, false, true, 1),
        ("lock: row lock", CHALLENGE_BY_ID.nth(1), false, true, 1),
        ("lock: participants", LIST_PARTICIPANTS.nth(1), false, true, 1),
        ("lock: activity", ACTIVITY_DAYS, false, true, 1),
        ("lock: store days", INSERT_DAYS, false, true, 1),
        ("lock: locked_through", SET_LOCKED_THROUGH, false, true, 1),
        ("listing challenges to finalize", IDS_TO_FINALIZE, true, false, 1),
        ("finalize: row lock", CHALLENGE_BY_ID.nth(2), true, false, 1),
        ("finalize: participants", LIST_PARTICIPANTS.nth(2), true, false, 1),
        ("finalize: totals", LOCKED_TOTALS, true, false, 1),
        ("finalize: results", SAVE_FINAL_RESULTS, true, false, 1),
        ("finalize: mark", MARK_FINALIZED, true, false, 1),
    ];
    for (name, fault, locked, finalized, processed) in tests {
        db.reset().await;
        let e = Ch::new(db, on(3));
        let (to_lock, to_finalize) = job_setup(&e).await;
        let svc = e.failing(fault).await;

        let err = svc.run_daily_job().await.expect_err(name);
        assert!(err.to_string().contains("injected failure"), "{name}: {err}");

        assert_eq!(load_challenge(&e.pool, to_lock.id).await.locked_through.is_some(), locked, "{name}: locked");
        assert_eq!(
            load_challenge(&e.pool, to_finalize.id).await.finalized_at.is_some(),
            finalized,
            "{name}: finalized"
        );
        if !finalized {
            let ranked = count(
                &e.pool,
                "challenge_participants",
                "challenge_id = $1 AND final_rank IS NOT NULL",
                &[to_finalize.id],
            )
            .await;
            assert_eq!(ranked, 0, "{name}: no partial results");
            assert_eq!(count(&e.pool, "notifications", "true", &[]).await, 0, "{name}");
        }
        let logs = cron_job_logs(&e.pool, CRON_JOB_CHALLENGE_DAILY).await;
        assert_eq!(logs.len(), 1, "{name}");
        assert_eq!(logs[0].status, CRON_JOB_STATUS_FAILED, "{name}");
        assert_eq!(logs[0].users_count, processed, "{name}");
        assert!(logs[0].error.contains("injected failure"), "{name}: {}", logs[0].error);

        // The next run retries and succeeds.
        e.clock.set_day(on(4));
        e.svc.run_daily_job().await.unwrap_or_else(|err| panic!("{name}: {err}"));
        assert!(load_challenge(&e.pool, to_lock.id).await.locked_through.is_some(), "{name}");
        assert!(load_challenge(&e.pool, to_finalize.id).await.finalized_at.is_some(), "{name}");
        assert_eq!(count(&e.pool, "notifications", "type = 'challenge_ended'", &[]).await, 2, "{name}");
    }

    // One failing challenge does not stop the others.
    db.reset().await;
    let e = Ch::new(db, on(3));
    let (to_lock, to_finalize) = job_setup(&e).await;
    let cat = user(&e.pool, "cat").await;
    let dan = user(&e.pool, "dan").await;
    let other = seed(&cat, cday(), 5).insert(&e.pool).await;
    join(&e.pool, &other, &dan, cday()).await;
    let svc = e.failing(INSERT_DAYS.nth(1)).await;
    let err = svc.run_daily_job().await.unwrap_err();
    let message = err.to_string();
    assert!(message.contains("injected failure"), "{message}");
    assert!(message.starts_with(&format!("lock challenge {}: store locked days: ", to_lock.id)), "{message}");
    assert_eq!(load_challenge(&e.pool, to_lock.id).await.locked_through, None, "the first challenge failed");
    assert!(load_challenge(&e.pool, other.id).await.locked_through.is_some());
    assert!(load_challenge(&e.pool, to_finalize.id).await.finalized_at.is_some());
    assert_eq!(cron_job_logs(&e.pool, CRON_JOB_CHALLENGE_DAILY).await[0].users_count, 2);

    // Claiming fails: the job runs anyway, it is idempotent.
    db.reset().await;
    let e = Ch::new(db, on(3));
    let (to_lock, _) = job_setup(&e).await;
    let broken = db.broken_pool().await;
    let svc = e.service(&e.pool, Some(&broken), Some(&e.pool));
    let (logs, guard) = LogCapture::start();
    svc.run_daily_job().await.unwrap();
    drop(guard);
    assert!(load_challenge(&e.pool, to_lock.id).await.locked_through.is_some());
    assert_eq!(logs.count("Failed to claim the challenge job, running without a job log"), 1);

    // Finalized meanwhile (by another replica, while this one waits for the row lock).
    db.reset().await;
    let e = Ch::new(db, on(3));
    let (_, to_finalize) = job_setup(&e).await;
    let mut other_replica = e.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM challenges WHERE id = $1 FOR UPDATE")
        .bind(to_finalize.id)
        .execute(&mut *other_replica)
        .await
        .unwrap();
    let svc = e.service(&e.pool, None, Some(&e.pool));
    let job = tokio::spawn(async move { svc.run_daily_job().await });
    wait_for_lock_waiter(&e.pool).await;
    sqlx::query("UPDATE challenges SET finalized_at = now() WHERE id = $1")
        .bind(to_finalize.id)
        .execute(&mut *other_replica)
        .await
        .unwrap();
    other_replica.commit().await.unwrap();
    job.await.unwrap().unwrap();
    assert_eq!(count(&e.pool, "notifications", "true", &[]).await, 0, "whoever finalized it notifies");
    let ranked =
        count(&e.pool, "challenge_participants", "challenge_id = $1 AND final_rank IS NOT NULL", &[to_finalize.id])
            .await;
    assert_eq!(ranked, 0);
}

async fn notification_failures_do_not_fail_requests(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let friend = user(&e.pool, "friend").await;
    follow(&e.pool, &ann, &friend, FOLLOW_STATE_ACTIVE).await;
    let notifications_pool = db.faulty_pool(fail(r"INSERT INTO notifications \(")).await;
    let svc = e.service(&e.pool, Some(&e.pool), Some(&notifications_pool));
    let (logs, guard) = LogCapture::start();

    let created = svc.create(ann.id, &study_request(cday(), 3)).await.unwrap();
    let id = created.summary.id;
    svc.join_by_code(ben.id, &created.invite_code).await.expect("join");
    assert!(!svc.cheer(ann.id, id, ben.id as u64).await.expect("cheer"));
    let (invited, _) = svc.invite(ann.id, id, &[friend.id as u64]).await.expect("invite");
    assert_eq!(invited, 1);
    e.clock.set_day(on(5));
    svc.run_daily_job().await.expect("the job");
    drop(guard);
    assert!(load_challenge(&e.pool, id).await.finalized_at.is_some());

    assert_eq!(count(&e.pool, "notifications", "true", &[]).await, 0);
    let mut kinds = std::collections::BTreeMap::new();
    for entry in logs.with_message("Challenge notification failed; the action itself succeeded") {
        *kinds.entry(entry.fields["type"].clone()).or_insert(0) += 1;
        assert_eq!(entry.fields["challenge_id"], id.to_string());
    }
    let expected: std::collections::BTreeMap<String, i32> =
        [("challenge_ended", 2), ("challenge_cheer", 1), ("challenge_invite", 1), ("challenge_joined", 1)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
    assert_eq!(kinds, expected);

    // Without a notification service.
    let quiet: ChallengeService = e.service(&e.pool, None, None);
    let c = seed(&ann, on(6), 3).insert(&e.pool).await;
    join(&e.pool, &c, &ann, on(5)).await;
    quiet.join_by_code(friend.id, &c.invite_code).await.unwrap();
    assert_eq!(count(&e.pool, "notifications", "true", &[]).await, 0);
}
