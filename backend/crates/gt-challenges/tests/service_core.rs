//! Service tests: creating, listing and reading challenges (port of
//! `services/challenge_create_test.go` and `challenge_detail_test.go`).

#[macro_use]
mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use common::*;
use gt_challenges::dto::{
    ChallengeDay, ChallengeParticipant, ChallengeProgress, ChallengeSummary, CreateChallengeRequest,
};
use gt_challenges::validator::normalize_invite_code;
use gt_challenges::ChallengeError;
use gt_core::constants as c;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn challenge_service_core() {
    let Some(db) = TestDb::new("service_core").await else {
        return;
    };
    cases!(
        db,
        "challenge service",
        create,
        create_open_challenge_limit,
        open_challenge_limit_under_concurrency,
        create_invite_code_collisions,
        list,
        detail_at_least,
        detail_at_most,
        detail_flags,
    );
    db.finish().await;
}

fn day(date: &str, hours: Option<f64>, status: &str, locked: bool) -> ChallengeDay {
    ChallengeDay { date: date.into(), hours, status: status.into(), locked }
}

async fn create(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user_with_avatar(&e.pool, "ann").await;

    let mut req = study_request(on(1), 21);
    req.title = "  Study 2h+ a day 📚 ".into();
    let detail = e.svc.create(ann.id, &req).await.unwrap();
    let s = &detail.summary;
    assert_ne!(s.id, 0);
    assert_eq!(s.title, "Study 2h+ a day 📚", "trimmed");
    assert_eq!(s.activity, "study");
    assert_eq!(s.goal_type, "at_least");
    assert_eq!(s.target_hours, 2.0);
    assert_eq!(s.start_date, "2026-03-10");
    assert_eq!(s.end_date, "2026-03-30");
    assert_eq!(s.duration_days, 21);
    assert_eq!(s.status, "upcoming");
    assert!(!s.finalized);
    assert_eq!(s.day_number, None);
    assert_eq!(s.participant_count, 1);
    assert!(s.is_creator);
    assert_eq!(normalize_invite_code(&detail.invite_code).as_deref(), Some(detail.invite_code.as_str()));
    assert_eq!(detail.today, "2026-03-09");
    assert_eq!(detail.locked_through, None);
    assert_eq!(detail.results_date, "2026-04-01", "end date + 2");
    assert_eq!(detail.completion_days, 17, "ceil(0.8 * 21)");
    assert_eq!(detail.max_participants, 50);
    assert_eq!(detail.creator, ch_user(&ann));
    assert!(detail.can_invite);
    assert!(!detail.can_leave, "the creator cannot leave");
    assert!(detail.can_delete);

    let progress = ChallengeProgress { days_possible: 21, ..Default::default() };
    assert_eq!(s.me, progress, "no rank, streak or completion before the start");
    assert_eq!(
        detail.participants,
        vec![ChallengeParticipant {
            progress: progress.clone(),
            user: ch_user(&ann),
            joined_on: "2026-03-09".into(),
            is_me: true,
            cheered_today: false,
            days: "U".repeat(21),
        }]
    );
    let my_days = detail.my_days.clone().unwrap();
    assert_eq!(my_days.len(), 21);
    assert_eq!(my_days[0], day("2026-03-10", None, "upcoming", false));
    assert_eq!(my_days[20], day("2026-03-30", None, "upcoming", false));

    let (user_id, joined_on, joined_at): (i64, chrono::NaiveDate, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT user_id, joined_on, joined_at FROM challenge_participants WHERE challenge_id = $1")
            .bind(s.id)
            .fetch_one(&e.pool)
            .await
            .unwrap();
    assert_eq!(user_id, ann.id, "the creator joins automatically");
    assert_eq!(joined_on, cday());
    assert_eq!(joined_at, e.clock.now());

    // Starting today.
    let detail = e.svc.create(ann.id, &study_request(cday(), 3)).await.unwrap();
    assert_eq!(detail.summary.status, "active");
    assert_eq!(detail.summary.day_number, Some(1));
    assert_eq!(
        detail.summary.me,
        ChallengeProgress {
            rank: Some(1),
            days_elapsed: 1,
            days_possible: 3,
            today_hours: Some(0.0),
            today_status: Some("pending".into()),
            ..Default::default()
        }
    );
    assert_eq!(detail.participants[0].days, "PUU");
    assert_eq!(detail.my_days.as_ref().unwrap()[0], day("2026-03-09", Some(0.0), "pending", false));
    assert!(detail.can_delete, "the creator is the only participant");

    // Boundaries.
    let requests = [
        ("🏆".repeat(60), "reels", "at_most", 0.0, 60, "2026-04-08"),
        ("x".into(), "sleep", "at_least", 24.0, 3, " 2026-03-09 "),
        ("y".into(), "office", "at_most", 23.75, 3, "2026-03-09"),
        ("z".into(), "workout", "at_least", 0.25, 3, "2026-03-09"),
    ];
    for (title, activity, goal, target, days, start) in requests {
        let req = CreateChallengeRequest {
            title,
            activity: activity.into(),
            goal_type: goal.into(),
            target_hours: Some(target),
            duration_days: Some(days),
            start_date: start.into(),
        };
        let detail = e.svc.create(ann.id, &req).await.unwrap_or_else(|err| panic!("{req:?}: {err}"));
        assert_eq!(detail.summary.target_hours, target);
        assert_eq!(detail.summary.duration_days, days);
    }

    // Validation.
    let before = count(&e.pool, "challenges", "true", &[]).await;
    type Mutate = fn(&mut CreateChallengeRequest);
    let tests: [(&str, Mutate, &str); 16] = [
        ("empty title", |r| r.title = "  ".into(), "title"),
        ("long title", |r| r.title = "a".repeat(61), "title"),
        ("custom tile", |r| r.activity = "custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f".into(), "activity"),
        ("unknown activity", |r| r.activity = "swimming".into(), "activity"),
        ("unknown goal", |r| r.goal_type = "exactly".into(), "goal_type"),
        ("missing target", |r| r.target_hours = None, "target_hours"),
        ("not a quarter hour", |r| r.target_hours = Some(2.1), "target_hours"),
        ("at_least zero", |r| r.target_hours = Some(0.0), "target_hours"),
        ("at_least over a day", |r| r.target_hours = Some(24.25), "target_hours"),
        (
            "at_most a whole day",
            |r| {
                r.goal_type = "at_most".into();
                r.target_hours = Some(24.0);
            },
            "target_hours",
        ),
        ("too short", |r| r.duration_days = Some(2), "duration_days"),
        ("too long", |r| r.duration_days = Some(61), "duration_days"),
        ("missing duration", |r| r.duration_days = None, "duration_days"),
        ("in the past", |r| r.start_date = "2026-03-08".into(), "start_date"),
        ("too far ahead", |r| r.start_date = "2026-04-09".into(), "start_date"),
        ("malformed start", |r| r.start_date = "09/03/2026".into(), "start_date"),
    ];
    for (name, mutate, field) in tests {
        let mut req = study_request(on(1), 21);
        mutate(&mut req);
        let (code, message) = validation(e.svc.create(ann.id, &req).await);
        assert_eq!(code, c::ERR_CODE_INVALID_CHALLENGE, "{name}");
        assert!(message.starts_with(&format!("{field} ")), "{name}: message {message:?} names {field}");
    }
    assert_eq!(count(&e.pool, "challenges", "true", &[]).await, before, "nothing is stored");

    // Unknown user.
    let result = e.svc.create(ann.id + 1000, &study_request(on(1), 3)).await;
    assert_err!(result, ChallengeError::Internal(_));
}

async fn create_open_challenge_limit(db: &TestDb) {
    let e = Ch::new(db, cday());
    let lim = user(&e.pool, "lim").await;
    let other = user(&e.pool, "other").await;

    let ended = seed(&other, on(-10), 5).insert(&e.pool).await; // ended challenges do not count
    join(&e.pool, &ended, &lim, on(-10)).await;
    let joined = seed(&other, on(2), 5).insert(&e.pool).await; // joined ones do
    join(&e.pool, &joined, &lim, cday()).await;
    for i in 0..9 {
        e.svc.create(lim.id, &study_request(on(i), 3)).await.unwrap_or_else(|err| panic!("challenge {}: {err}", i + 1));
    }

    assert_err!(e.svc.create(lim.id, &study_request(on(1), 3)).await, ChallengeError::LimitReached);
    assert_eq!(count(&e.pool, "challenges", "creator_id = $1", &[lim.id]).await, 9);

    // Three days later the first one has ended, which makes room for one more.
    e.clock.set_day(on(3));
    e.svc.create(lim.id, &study_request(on(3), 3)).await.unwrap();
    assert_err!(e.svc.create(lim.id, &study_request(on(3), 3)).await, ChallengeError::LimitReached);
}

async fn open_challenge_limit_under_concurrency(db: &TestDb) {
    let e = Ch::new(db, cday());
    let owner = user(&e.pool, "owner").await;
    let racer = user(&e.pool, "racer").await;
    for _ in 0..c::CHALLENGE_MAX_OPEN_PER_USER - 2 {
        let challenge = seed(&owner, on(1), 5).insert(&e.pool).await;
        join(&e.pool, &challenge, &racer, cday()).await;
    }
    let mut codes = Vec::new();
    for _ in 0..3 {
        let challenge = seed(&owner, on(1), 5).insert(&e.pool).await;
        join(&e.pool, &challenge, &owner, cday()).await;
        codes.push(challenge.invite_code);
    }

    // Three joins and two creates race for the last two places.
    let svc = Arc::new(e.svc.clone());
    let start = Arc::new(tokio::sync::Barrier::new(5));
    let mut tasks = Vec::new();
    for i in 0..5 {
        let (svc, start, code) = (svc.clone(), start.clone(), codes.get(i).cloned());
        let racer = racer.id;
        tasks.push(tokio::spawn(async move {
            start.wait().await;
            match code {
                Some(code) => svc.join_by_code(racer, &code).await,
                None => svc.create(racer, &study_request(on(1), 3)).await,
            }
        }));
    }
    let (mut succeeded, mut limited) = (0, 0);
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => succeeded += 1,
            Err(ChallengeError::LimitReached) => limited += 1,
            Err(err) => panic!("unexpected error: {err:#}"),
        }
    }
    assert_eq!((succeeded, limited), (2, 3));
    let open = e.svc.repository().conn().await.unwrap().count_open_for_user(racer.id, cday()).await.unwrap();
    assert_eq!(open, c::CHALLENGE_MAX_OPEN_PER_USER);
}

async fn create_invite_code_collisions(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let first = e.svc.create(ann.id, &study_request(on(1), 3)).await.unwrap();
    let (logs, _guard) = LogCapture::start();

    let codes = [first.invite_code.clone(), first.invite_code.clone(), "NEWCQDE2".to_string()];
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let svc = e.svc.clone().with_code_generator(move || {
        let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
        codes[n.min(codes.len()) - 1].clone()
    });
    let second = svc.create(ann.id, &study_request(on(1), 3)).await.unwrap();
    assert_eq!(second.invite_code, "NEWCQDE2");
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(logs.count("Challenge invite code collision, retrying with a new code"), 2);

    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let taken = first.invite_code.clone();
    let svc = e.svc.clone().with_code_generator(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        taken.clone()
    });
    match svc.create(ann.id, &study_request(on(1), 3)).await {
        Err(err @ ChallengeError::Internal(_)) => {
            assert_eq!(format!("{err:#}"), "create challenge: invite code already taken");
        }
        other => panic!("expected the code to be taken, got {:?}", other.map(|_| "Ok")),
    }
    assert_eq!(calls.load(Ordering::SeqCst), 5);
    assert_eq!(count(&e.pool, "challenges", "true", &[]).await, 2);
    assert_eq!(count(&e.pool, "challenge_participants", "true", &[]).await, 2, "nothing is left behind");
}

async fn list(db: &TestDb) {
    let today = on(10);
    let e = Ch::new(db, today);
    let me = user(&e.pool, "me").await;
    let rival = user(&e.pool, "rival").await;

    let active1 = seed(&rival, on(5), 10).insert(&e.pool).await; // ends on(14)
    join(&e.pool, &active1, &rival, on(4)).await;
    join(&e.pool, &active1, &me, on(4)).await;
    let active2 = seed(&me, on(8), 5).insert(&e.pool).await; // ends on(12)
    join(&e.pool, &active2, &me, on(8)).await;
    let upcoming1 = seed(&me, on(15), 5).insert(&e.pool).await;
    join(&e.pool, &upcoming1, &me, today).await;
    let upcoming2 = seed(&rival, on(12), 3).insert(&e.pool).await;
    join(&e.pool, &upcoming2, &rival, today).await;
    join(&e.pool, &upcoming2, &me, today).await;
    let mut ended = Vec::new();
    for i in 0..22 {
        let challenge = seed(&me, on(7 - i), 3).insert(&e.pool).await; // ends on(9-i)
        join(&e.pool, &challenge, &me, on(7 - i)).await;
        ended.push(challenge);
    }
    let finalized = ended[3].clone();
    let standing = FinalStanding { rank: 3, days_met: 2, hours: 9.5, completed: false };
    finalize(&e.pool, &finalized, &me, standing, e.clock.now()).await;
    let not_mine = seed(&rival, today, 3).insert(&e.pool).await;
    join(&e.pool, &not_mine, &rival, today).await;

    log_activity(&e.pool, &me, "study", 2.5, today).await;
    log_activity(&e.pool, &rival, "study", 3.0, on(9)).await;

    let list = e.svc.list(me.id).await.unwrap();
    let ids: Vec<i64> = list.iter().map(|s| s.id).collect();
    let mut want = vec![active2.id, active1.id, upcoming2.id, upcoming1.id];
    want.extend(ended[..20].iter().map(|c| c.id));
    assert_eq!(ids, want, "active by end date, upcoming by start date, then the 20 most recent ended");

    let a1 = &list[1];
    assert_eq!(a1.status, "active");
    assert_eq!(a1.day_number, Some(6));
    assert_eq!(a1.participant_count, 2);
    assert!(!a1.is_creator);
    assert_eq!(
        a1.me,
        ChallengeProgress {
            rank: Some(2),
            days_met: 1,
            days_elapsed: 6,
            days_possible: 10,
            current_streak: 1,
            total_hours: 2.5,
            today_hours: Some(2.5),
            today_status: Some("met".into()),
            completed: None,
        },
        "rival met a day with more hours"
    );

    assert!(list[0].is_creator);
    assert_eq!(list[0].me.rank, Some(1));
    assert_eq!(list[2].me, ChallengeProgress { days_possible: 3, ..Default::default() }, "upcoming: no rank");
    assert_eq!(list[2].status, "upcoming");

    let e0 = &list[4];
    assert_eq!(e0.status, "ended");
    assert!(!e0.finalized);
    assert_eq!(e0.day_number, None);
    assert_eq!(
        e0.me,
        ChallengeProgress { rank: Some(1), days_elapsed: 3, days_possible: 3, ..Default::default() },
        "completion is unknown until finalized"
    );

    let f = &list[7];
    assert_eq!(f.id, finalized.id);
    assert!(f.finalized);
    assert_eq!(
        f.me,
        ChallengeProgress {
            rank: Some(3),
            days_met: 2,
            days_elapsed: 3,
            days_possible: 3,
            total_hours: 9.5,
            completed: Some(false),
            ..Default::default()
        },
        "the stored results"
    );

    // The list shows what the detail shows.
    for s in &list {
        let detail = e.svc.get_detail(me.id, s.id).await.unwrap();
        assert_eq!(s, &detail.summary, "challenge {}", s.id);
    }

    let rivals = e.svc.list(rival.id).await.unwrap();
    assert_eq!(rivals.iter().map(|s| s.id).collect::<Vec<_>>(), vec![not_mine.id, active1.id, upcoming2.id]);
    assert_eq!(rivals[1].me.rank, Some(1), "more hours than me on as many days");

    let nobody = user(&e.pool, "nobody").await;
    assert!(e.svc.list(nobody.id).await.unwrap().is_empty());
}

// Study 2h+ over 7 days, on day 5, with the first 3 days locked. Ann (the creator) joined
// before the start, Ben on the start date and Cat on day 4.
async fn detail_at_least(db: &TestDb) {
    let today = on(4);
    let e = Ch::new(db, today);
    let ann = user_with_avatar(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;
    let cat = user(&e.pool, "cat").await;
    let dan = user(&e.pool, "dan").await;
    let challenge = seed(&ann, cday(), 7).locked(on(2)).insert(&e.pool).await;
    join(&e.pool, &challenge, &ann, on(-1)).await;
    join(&e.pool, &challenge, &ben, cday()).await;
    join(&e.pool, &challenge, &cat, on(3)).await;
    snapshot(&e.pool, &challenge, &ann, cday(), 2.0, true).await;
    snapshot(&e.pool, &challenge, &ann, on(1), 3.0, true).await;
    snapshot(&e.pool, &challenge, &ann, on(2), 1.0, false).await;
    snapshot(&e.pool, &challenge, &ben, cday(), 2.5, true).await;
    snapshot(&e.pool, &challenge, &ben, on(1), 2.0, true).await;
    snapshot(&e.pool, &challenge, &ben, on(2), 2.0, true).await;
    log_activity(&e.pool, &ann, "study", 5.0, on(2)).await; // logged after the day was locked: ignored
    log_activity(&e.pool, &ann, "study", 2.0, on(3)).await;
    log_activity(&e.pool, &ann, "study", 2.5, today).await;
    log_activity(&e.pool, &ann, "sleep", 8.0, today).await;
    log_activity(&e.pool, &ben, "study", 1.0, on(3)).await;
    log_activity(&e.pool, &cat, "study", 9.0, on(2)).await; // before Cat joined: ignored
    log_activity(&e.pool, &cat, "study", 4.0, on(3)).await;
    log_activity(&e.pool, &cat, "study", 1.0, today).await;
    assert!(!e.svc.cheer(ann.id, challenge.id, ben.id as u64).await.unwrap());

    let ann_progress = ChallengeProgress {
        rank: Some(1),
        days_met: 4,
        days_elapsed: 5,
        days_possible: 7,
        current_streak: 2,
        total_hours: 10.5,
        today_hours: Some(2.5),
        today_status: Some("met".into()),
        completed: None,
    };
    let ben_progress = ChallengeProgress {
        rank: Some(2),
        days_met: 3,
        days_elapsed: 5,
        days_possible: 7,
        current_streak: 0,
        total_hours: 7.5,
        today_hours: Some(0.0),
        today_status: Some("pending".into()),
        completed: None,
    };
    let cat_progress = ChallengeProgress {
        rank: Some(3),
        days_met: 1,
        days_elapsed: 2,
        days_possible: 4,
        current_streak: 1,
        total_hours: 5.0,
        today_hours: Some(1.0),
        today_status: Some("pending".into()),
        completed: None,
    };

    let detail = e.svc.get_detail(ann.id, challenge.id).await.unwrap();
    assert_eq!(
        detail.summary,
        ChallengeSummary {
            id: challenge.id,
            title: "Study 2h+".into(),
            activity: "study".into(),
            goal_type: "at_least".into(),
            target_hours: 2.0,
            start_date: "2026-03-09".into(),
            end_date: "2026-03-15".into(),
            duration_days: 7,
            status: "active".into(),
            finalized: false,
            day_number: Some(5),
            participant_count: 3,
            is_creator: true,
            me: ann_progress.clone(),
        }
    );
    assert_eq!(detail.invite_code, challenge.invite_code);
    assert_eq!(detail.today, "2026-03-13");
    assert_eq!(detail.locked_through.as_deref(), Some("2026-03-11"));
    assert_eq!(detail.results_date, "2026-03-17");
    assert_eq!(detail.completion_days, 6);
    assert_eq!(detail.creator, ch_user(&ann));
    assert!(detail.can_invite);
    assert!(!detail.can_leave);
    assert!(!detail.can_delete, "started, with other participants");
    let participant =
        |progress: &ChallengeProgress, u: &TestUser, joined_on: &str, is_me: bool, cheered: bool, days: &str| {
            ChallengeParticipant {
                progress: progress.clone(),
                user: ch_user(u),
                joined_on: joined_on.into(),
                is_me,
                cheered_today: cheered,
                days: days.into(),
            }
        };
    assert_eq!(
        detail.participants,
        vec![
            participant(&ann_progress, &ann, "2026-03-08", true, false, "MMXMMUU"),
            participant(&ben_progress, &ben, "2026-03-09", false, true, "MMMPPUU"),
            participant(&cat_progress, &cat, "2026-03-12", false, false, "---MPUU"),
        ]
    );
    assert_eq!(
        detail.my_days,
        Some(vec![
            day("2026-03-09", Some(2.0), "met", true),
            day("2026-03-10", Some(3.0), "met", true),
            day("2026-03-11", Some(1.0), "missed", true),
            day("2026-03-12", Some(2.0), "met", false),
            day("2026-03-13", Some(2.5), "met", false),
            day("2026-03-14", None, "upcoming", false),
            day("2026-03-15", None, "upcoming", false),
        ])
    );

    // Seen by another participant.
    let detail = e.svc.get_detail(ben.id, challenge.id).await.unwrap();
    assert!(!detail.summary.is_creator);
    assert_eq!(detail.summary.me, ben_progress);
    assert!(detail.can_leave);
    assert!(!detail.can_delete);
    assert!(participant_of(&detail, ben.id).is_me);
    assert!(!participant_of(&detail, ann.id).is_me);
    assert!(detail.participants.iter().all(|p| !p.cheered_today), "Ben cheered nobody");
    assert_eq!(detail.my_days.as_ref().unwrap()[3], day("2026-03-12", Some(1.0), "pending", false));

    // A late joiner's days before joining.
    let detail = e.svc.get_detail(cat.id, challenge.id).await.unwrap();
    assert_eq!(detail.summary.me, cat_progress);
    assert_eq!(detail.my_days.as_ref().unwrap()[0], day("2026-03-09", None, "none", true));
    assert_eq!(detail.my_days.as_ref().unwrap()[3], day("2026-03-12", Some(4.0), "met", false));

    // The list agrees.
    for u in [&ann, &ben, &cat] {
        let list = e.svc.list(u.id).await.unwrap();
        assert_eq!(list.len(), 1);
        let detail = e.svc.get_detail(u.id, challenge.id).await.unwrap();
        assert_eq!(detail.summary, list[0], "{}", u.username);
    }

    // Not a participant.
    assert_err!(e.svc.get_detail(dan.id, challenge.id).await, ChallengeError::NotFound);
    assert_err!(e.svc.get_detail(ann.id, challenge.id + 100).await, ChallengeError::NotFound);
}

// Reels at most 1h a day, on day 3, nothing locked.
async fn detail_at_most(db: &TestDb) {
    let today = on(2);
    let e = Ch::new(db, today);
    let max = user(&e.pool, "max").await;
    let lee = user(&e.pool, "lee").await;
    let kim = user(&e.pool, "kim").await;
    let challenge = seed(&max, cday(), 5).goal("Reels ≤ 1h", "reels", "at_most", 1.0).insert(&e.pool).await;
    for u in [&max, &lee, &kim] {
        join(&e.pool, &challenge, u, cday()).await;
    }
    log_activity(&e.pool, &max, "reels", 0.5, cday()).await;
    log_activity(&e.pool, &max, "study", 3.0, on(1)).await; // logged, but no reels at all: met
    log_activity(&e.pool, &lee, "reels", 2.0, cday()).await; // over the limit: missed
    log_activity(&e.pool, &lee, "reels", 0.75, today).await;
    log_activity(&e.pool, &kim, "reels", 0.25, cday()).await;
    log_activity(&e.pool, &kim, "reels", 0.25, on(1)).await;

    let detail = e.svc.get_detail(lee.id, challenge.id).await.unwrap();
    let order: Vec<&str> = detail.participants.iter().map(|p| p.user.username.as_str()).collect();
    assert_eq!(order, ["kim", "max", "lee"], "by rank, ties by username");

    let max_entry = participant_of(&detail, max.id);
    assert_eq!(
        max_entry.progress,
        ChallengeProgress {
            rank: Some(1),
            days_met: 2,
            days_elapsed: 3,
            days_possible: 5,
            current_streak: 2,
            total_hours: 0.5,
            today_hours: Some(0.0),
            today_status: Some("pending".into()),
            completed: None,
        },
        "nothing logged today: pending, yesterday's streak counts"
    );
    assert_eq!(max_entry.days, "MMPUU");
    assert_eq!(participant_of(&detail, kim.id).progress, max_entry.progress, "same days and hours share rank 1");
    let lee_entry = participant_of(&detail, lee.id);
    assert_eq!(
        lee_entry.progress,
        ChallengeProgress {
            rank: Some(3),
            days_met: 1,
            days_elapsed: 3,
            days_possible: 5,
            current_streak: 1,
            total_hours: 2.75,
            today_hours: Some(0.75),
            today_status: Some("met".into()),
            completed: None,
        }
    );
    assert_eq!(lee_entry.days, "XPMUU", "an unlogged past day stays pending until it locks");
    assert_eq!(
        detail.my_days,
        Some(vec![
            day("2026-03-09", Some(2.0), "missed", false),
            day("2026-03-10", Some(0.0), "pending", false),
            day("2026-03-11", Some(0.75), "met", false),
            day("2026-03-12", None, "upcoming", false),
            day("2026-03-13", None, "upcoming", false),
        ])
    );

    // Fewer hours rank higher: one more quarter hour costs Kim the tie.
    log_activity(&e.pool, &kim, "reels", 0.25, on(1)).await;
    let detail = e.svc.get_detail(lee.id, challenge.id).await.unwrap();
    assert_eq!(participant_of(&detail, max.id).progress.rank, Some(1));
    assert_eq!(participant_of(&detail, kim.id).progress.rank, Some(2));
    assert_eq!(participant_of(&detail, lee.id).progress.rank, Some(3));
}

async fn detail_flags(db: &TestDb) {
    let e = Ch::new(db, cday());
    let ann = user(&e.pool, "ann").await;
    let ben = user(&e.pool, "ben").await;

    // (name, start, with ben, viewer, can_invite, can_leave, can_delete)
    let tests = [
        ("upcoming, creator with others", 1, true, &ann, true, false, true),
        ("upcoming, participant", 1, true, &ben, true, true, false),
        ("active, creator alone", -1, false, &ann, true, false, true),
        ("active, creator with others", -1, true, &ann, true, false, false),
        ("active, participant", -1, true, &ben, true, true, false),
        ("ended, creator alone", -9, false, &ann, false, false, true),
        ("ended, creator with others", -9, true, &ann, false, false, false),
        ("ended, participant", -9, true, &ben, false, false, false),
    ];
    for (name, start, with_ben, viewer, can_invite, can_leave, can_delete) in tests {
        let challenge = seed(&ann, on(start), 5).insert(&e.pool).await;
        join(&e.pool, &challenge, &ann, on(start)).await;
        if with_ben {
            join(&e.pool, &challenge, &ben, on(start)).await;
        }
        let detail = e.svc.get_detail(viewer.id, challenge.id).await.unwrap();
        assert_eq!(
            (detail.can_invite, detail.can_leave, detail.can_delete),
            (can_invite, can_leave, can_delete),
            "{name}: can_invite, can_leave, can_delete"
        );
    }
}
