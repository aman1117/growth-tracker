//! HTTP tests of the challenge routes (port of `handlers/challenge_test.go` and
//! `challenge_actions_test.go`), through the real router with its guards.

#[macro_use]
mod common;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::Request;
use axum::Router;
use common::*;
use gt_challenges::ChallengesContext;
use gt_core::config::Config;
use gt_core::constants as c;
use gt_core::models::{
    Challenge, FOLLOW_STATE_ACTIVE, NOTIF_TYPE_CHALLENGE_CHEER, NOTIF_TYPE_CHALLENGE_INVITE,
    NOTIF_TYPE_CHALLENGE_JOINED,
};
use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn challenge_http() {
    let Some(db) = TestDb::new("http").await else {
        return;
    };
    cases!(
        db,
        "challenge http",
        requires_auth,
        create_challenge,
        list_challenges,
        get_challenge,
        delete_challenge,
        leave_challenge,
        cheer_participant,
        get_invite_candidates,
        invite_users,
        preview_challenge,
        join_challenge,
        server_errors,
        guards_and_limiters,
    );
    db.finish().await;
}

// ==================== Harness ====================

fn config() -> Config {
    let mut config = Config::from_env();
    config.jwt.secret_key = "gt-challenges-test-secret".into();
    config
}

/// The challenge routes on a fresh core (fresh rate limiters) with the clock at noon IST on
/// [`cday`].
struct App {
    core: CoreContext,
    router: Router,
    pool: PgPool,
    clock: ManualClock,
}

impl App {
    fn new(db: &TestDb) -> App {
        App::with_challenges(db, &db.pool)
    }

    /// An app whose challenge service runs on `challenges` (e.g. a broken pool).
    fn with_challenges(db: &TestDb, challenges: &PgPool) -> App {
        let core = CoreContext::new(Arc::new(config()), db.pool.clone());
        let users = UsersContext::new(&core);
        let notify = NotifyContext::new(&core);
        let clock = ManualClock::at_day(cday());
        let svc = service(challenges, Some(&db.pool), Some(&db.pool), &clock);
        let challenges = ChallengesContext::new(&core, &users, &notify).with_service(Arc::new(svc));
        let router = gt_challenges::routes(&core, &users, &notify, &challenges);
        App { core, router, pool: db.pool.clone(), clock }
    }

    fn token(&self, user_id: i64) -> String {
        self.core.tokens.generate(user_id, &format!("user{user_id}")).unwrap().token
    }

    /// Sends a request as `user` (no token when `None`); `body` is sent raw as JSON.
    async fn raw(&self, user: Option<i64>, method: &str, uri: &str, body: Option<&str>) -> Res {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(user_id) = user {
            builder = builder.header("Authorization", format!("Bearer {}", self.token(user_id)));
        }
        let mut req = match body {
            Some(body) => {
                builder.header("Content-Type", "application/json").body(Body::from(body.to_string())).unwrap()
            }
            None => builder.body(Body::empty()).unwrap(),
        };
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 40000))));
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        Res { status, headers, body: String::from_utf8(bytes.to_vec()).unwrap() }
    }

    async fn call(&self, user: &TestUser, method: &str, uri: &str, body: Option<Value>) -> Res {
        self.raw(Some(user.id), method, uri, body.map(|b| b.to_string()).as_deref()).await
    }
}

struct Res {
    status: u16,
    headers: axum::http::HeaderMap,
    body: String,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|err| panic!("{err}: {}", self.body))
    }

    /// Asserts the Go error envelope.
    fn assert_error(&self, status: u16, code: &str, message: &str) {
        assert_eq!(
            (self.status, self.json()),
            (status, json!({"success": false, "error": message, "error_code": code})),
            "{}",
            self.body
        );
    }

    fn assert_error_code(&self, status: u16, code: &str) {
        assert_eq!((self.status, self.json()["error_code"].as_str()), (status, Some(code)), "{}", self.body);
    }

    fn assert_ok(&self, status: u16) -> Value {
        assert_eq!(self.status, status, "{}", self.body);
        self.json()
    }
}

/// (name, user, uri, raw body, (status, error code, message)).
type BodyCase<'a> = (&'a str, &'a TestUser, String, String, (u16, &'a str, &'a str));

fn path(challenge: &Challenge, suffix: &str) -> String {
    format!("/api/challenges/{}{suffix}", challenge.id)
}

/// A "Study 2h+" challenge of `days` days from `on(start)` created by `creator`, who takes
/// part with `others` (in that joining order), all joined on `on(min(start, 0))`.
async fn seed_challenge(pool: &PgPool, creator: &TestUser, start: i64, days: i64, others: &[&TestUser]) -> Challenge {
    let challenge = seed(creator, on(start), days).insert(pool).await;
    let joined_on = on(start.min(0));
    join(pool, &challenge, creator, joined_on).await;
    for u in others {
        join(pool, &challenge, u, joined_on).await;
    }
    challenge
}

fn create_body(start: i64, days: i64) -> Value {
    json!({
        "title": "Study 2h+", "activity": "study", "goal_type": "at_least",
        "target_hours": 2, "duration_days": days, "start_date": ymd(on(start)),
    })
}

/// The sorted keys of a JSON object.
fn keys(v: &Value) -> Vec<String> {
    let mut keys: Vec<String> =
        v.as_object().unwrap_or_else(|| panic!("{v} is not an object")).keys().cloned().collect();
    keys.sort();
    keys
}

fn sorted(keys: &[&str]) -> Vec<String> {
    let mut keys: Vec<String> = keys.iter().map(|k| k.to_string()).collect();
    keys.sort();
    keys
}

const USER_KEYS: &[&str] = &["id", "username", "profile_pic", "profile_pic_thumb", "is_verified"];
const PROGRESS_KEYS: &[&str] = &[
    "rank",
    "days_met",
    "days_elapsed",
    "days_possible",
    "current_streak",
    "total_hours",
    "today_hours",
    "today_status",
    "completed",
];
const SUMMARY_KEYS: &[&str] = &[
    "id",
    "title",
    "activity",
    "goal_type",
    "target_hours",
    "start_date",
    "end_date",
    "duration_days",
    "status",
    "finalized",
    "day_number",
    "participant_count",
    "is_creator",
    "me",
];
const DETAIL_KEYS: &[&str] = &[
    "invite_code",
    "today",
    "locked_through",
    "results_date",
    "completion_days",
    "max_participants",
    "creator",
    "can_invite",
    "can_leave",
    "can_delete",
    "participants",
    "my_days",
];
const PARTICIPANT_KEYS: &[&str] = &["user", "joined_on", "is_me", "cheered_today", "days"];

/// Checks the JSON shape of a challenge detail.
fn assert_detail_shape(challenge: &Value) {
    assert_eq!(keys(challenge), sorted(&[SUMMARY_KEYS, DETAIL_KEYS].concat()));
    assert_eq!(keys(&challenge["me"]), sorted(PROGRESS_KEYS));
    assert_eq!(keys(&challenge["creator"]), sorted(USER_KEYS));
    let participant = &challenge["participants"][0];
    assert_eq!(keys(participant), sorted(&[PROGRESS_KEYS, PARTICIPANT_KEYS].concat()));
    assert_eq!(keys(&participant["user"]), sorted(USER_KEYS));
    assert_eq!(keys(&challenge["my_days"][0]), sorted(&["date", "hours", "status", "locked"]));
}

// ==================== Tests ====================

const ROUTES: [(&str, &str); 10] = [
    ("GET", "/api/challenges"),
    ("POST", "/api/challenges"),
    ("GET", "/api/challenges/1"),
    ("DELETE", "/api/challenges/1"),
    ("POST", "/api/challenges/1/leave"),
    ("POST", "/api/challenges/1/cheers"),
    ("GET", "/api/challenges/1/invite-candidates"),
    ("POST", "/api/challenges/1/invites"),
    ("GET", "/api/challenge-codes/ABCDEFGH"),
    ("POST", "/api/challenge-codes/ABCDEFGH/join"),
];

async fn requires_auth(db: &TestDb) {
    let app = App::new(db);
    for (method, uri) in ROUTES {
        let res = app.raw(None, method, uri, None).await;
        res.assert_error(401, c::ERR_CODE_MISSING_AUTH_HEADER, "Missing Authorization Header");
        // Go: a token without a user id reaches the handler, which answers 401 itself.
        let res = app.raw(Some(0), method, uri, Some("{}")).await;
        res.assert_error(401, c::ERR_CODE_UNAUTHORIZED, "Authentication required");
    }
}

async fn create_challenge(db: &TestDb) {
    let app = App::new(db);
    let ann = user_with_avatar(&app.pool, "ann").await;

    let body = json!({
        "title": "  Study 2h+ a day 📚 ", "activity": "study", "goal_type": "at_least",
        "target_hours": 2.5, "duration_days": 21, "start_date": "2026-03-10",
    });
    let res = app.call(&ann, "POST", "/api/challenges", Some(body)).await;
    let body = res.assert_ok(201);
    assert_eq!(body["success"], json!(true));
    assert_eq!(keys(&body), sorted(&["success", "challenge"]));
    let challenge = &body["challenge"];
    assert_detail_shape(challenge);
    assert_eq!(challenge["title"], "Study 2h+ a day 📚");
    assert_eq!(challenge["target_hours"], json!(2.5));
    assert_eq!(challenge["start_date"], "2026-03-10");
    assert_eq!(challenge["end_date"], "2026-03-30");
    assert_eq!(challenge["status"], "upcoming");
    assert_eq!(challenge["invite_code"].as_str().unwrap().len(), c::CHALLENGE_INVITE_CODE_LENGTH);
    assert_eq!(challenge["today"], "2026-03-09");
    assert_eq!(challenge["is_creator"], json!(true));
    assert_eq!(
        challenge["creator"],
        json!({
            "id": ann.id, "username": "ann", "profile_pic": ann.profile_pic,
            "profile_pic_thumb": ann.profile_pic_thumb, "is_verified": true,
        })
    );
    assert_eq!(challenge["participants"].as_array().unwrap().len(), 1);
    assert_eq!(challenge["participants"][0]["is_me"], json!(true));
    assert_eq!(challenge["my_days"].as_array().unwrap().len(), 21);
    assert!(res.body.starts_with(r#"{"success":true,"challenge":{"id":"#), "{}", res.body);

    // Malformed bodies.
    for body in [r#""not json""#, r#"{"duration_days":"three"}"#, "[1]", "not json", "", r#"{"duration_days":3.0}"#] {
        let res = app.raw(Some(ann.id), "POST", "/api/challenges", Some(body)).await;
        res.assert_error(400, c::ERR_CODE_INVALID_REQUEST, "Invalid request body");
    }

    // Validation.
    let tests: [(&str, Value, &str); 7] = [
        ("title", json!({"title": " "}), "title must be between 1 and 60 characters"),
        (
            "activity",
            json!({"activity": "custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"}),
            "activity must be one of the predefined activities",
        ),
        ("goal", json!({"goal_type": "exactly"}), "goal_type must be at_least or at_most"),
        ("target", json!({"target_hours": 1.1}), "target_hours must be a multiple of 0.25 between 0.25 and 24"),
        ("missing target", json!({"target_hours": null}), "target_hours is required"),
        ("duration", json!({"duration_days": 61}), "duration_days must be between 3 and 60"),
        ("start", json!({"start_date": "2026-03-08"}), "start_date must be between today and 30 days from today"),
    ];
    for (name, change, message) in tests {
        let mut body = create_body(1, 7);
        for (k, v) in change.as_object().unwrap() {
            body[k] = v.clone();
        }
        let res = app.call(&ann, "POST", "/api/challenges", Some(body)).await;
        assert_eq!(res.status, 400, "{name}");
        res.assert_error(400, c::ERR_CODE_INVALID_CHALLENGE, message);
    }

    // Open challenge limit.
    let busy = any_user(&app.pool).await;
    for _ in 0..c::CHALLENGE_MAX_OPEN_PER_USER {
        seed_challenge(&app.pool, &busy, 1, 5, &[]).await;
    }
    let res = app.call(&busy, "POST", "/api/challenges", Some(create_body(1, 7))).await;
    res.assert_error(
        409,
        c::ERR_CODE_CHALLENGE_LIMIT_REACHED,
        "You already take part in the maximum number of open challenges",
    );
}

async fn list_challenges(db: &TestDb) {
    let app = App::new(db);
    let ann = any_user(&app.pool).await;
    let ben = any_user(&app.pool).await;

    let res = app.call(&ann, "GET", "/api/challenges", None).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true,"challenges":[]}"#));
    assert_eq!(res.headers["content-type"], "application/json");

    let active = seed_challenge(&app.pool, &ann, -2, 7, &[&ben]).await;
    let upcoming = seed_challenge(&app.pool, &ben, 3, 5, &[&ann]).await;
    seed_challenge(&app.pool, &ben, 1, 5, &[]).await; // not ann's

    let body = app.call(&ann, "GET", "/api/challenges", None).await.assert_ok(200);
    assert_eq!(body["success"], json!(true));
    let list = body["challenges"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["id"], json!(active.id));
    assert_eq!(list[1]["id"], json!(upcoming.id));
    assert_eq!(list[0]["is_creator"], json!(true));
    assert_eq!(list[0]["participant_count"], json!(2));
    assert_eq!(list[0]["day_number"], json!(3));
    assert_eq!(list[1]["day_number"], Value::Null);
    assert_eq!(keys(&list[0]), sorted(SUMMARY_KEYS));
    assert_eq!(keys(&list[0]["me"]), sorted(PROGRESS_KEYS));
}

async fn get_challenge(db: &TestDb) {
    let app = App::new(db);
    let ann = any_user(&app.pool).await;
    let ben = any_user(&app.pool).await;
    let outsider = any_user(&app.pool).await;
    let challenge = seed_challenge(&app.pool, &ann, -1, 5, &[&ben]).await;
    log_activity(&app.pool, &ben, "study", 2.5, cday()).await;

    let body = app.call(&ben, "GET", &path(&challenge, ""), None).await.assert_ok(200);
    let detail = &body["challenge"];
    assert_detail_shape(detail);
    assert_eq!(detail["id"], json!(challenge.id));
    assert_eq!(detail["is_creator"], json!(false));
    assert_eq!(detail["me"]["today_hours"], json!(2.5));
    assert_eq!(detail["me"]["today_status"], "met");
    assert_eq!(detail["me"]["rank"], json!(1));
    assert_eq!(detail["invite_code"], json!(challenge.invite_code));
    let leading_zeros = app.call(&ben, "GET", &format!("/api/challenges/000{}", challenge.id), None).await;
    assert_eq!(leading_zeros.assert_ok(200)["challenge"]["id"], json!(challenge.id), "ParseUint accepts leading zeros");

    for id in ["abc", "0", "-1", "+1", "1.5", "4294967296", "99999999999999999999", "%31"] {
        let res = app.call(&ben, "GET", &format!("/api/challenges/{id}"), None).await;
        res.assert_error(400, c::ERR_CODE_INVALID_REQUEST, "Invalid challenge ID");
    }

    // Non-participants and unknown challenges look the same.
    for uri in [path(&challenge, ""), format!("/api/challenges/{}", challenge.id + 100)] {
        let res = app.call(&outsider, "GET", &uri, None).await;
        res.assert_error(404, c::ERR_CODE_CHALLENGE_NOT_FOUND, "Challenge not found");
    }
}

async fn delete_challenge(db: &TestDb) {
    let app = App::new(db);
    let ann = any_user(&app.pool).await;
    let ben = any_user(&app.pool).await;
    let outsider = any_user(&app.pool).await;

    let upcoming = seed_challenge(&app.pool, &ann, 1, 5, &[&ben]).await;
    let res = app.call(&ben, "DELETE", &path(&upcoming, ""), None).await;
    res.assert_error(403, c::ERR_CODE_NOT_AUTHORIZED, "Only the creator can delete this challenge");
    app.call(&outsider, "DELETE", &path(&upcoming, ""), None)
        .await
        .assert_error_code(404, c::ERR_CODE_CHALLENGE_NOT_FOUND);
    app.call(&ann, "DELETE", "/api/challenges/x", None).await.assert_error_code(400, c::ERR_CODE_INVALID_REQUEST);

    let res = app.call(&ann, "DELETE", &path(&upcoming, ""), None).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true}"#));
    assert_eq!(count(&app.pool, "challenges", "id = $1", &[upcoming.id]).await, 0);

    let active = seed_challenge(&app.pool, &ann, -1, 5, &[&ben]).await;
    let res = app.call(&ann, "DELETE", &path(&active, ""), None).await;
    res.assert_error(
        409,
        c::ERR_CODE_CHALLENGE_IN_PROGRESS,
        "A challenge can only be deleted before it starts or while you are its only participant",
    );
}

async fn leave_challenge(db: &TestDb) {
    let app = App::new(db);
    let ann = any_user(&app.pool).await;
    let ben = any_user(&app.pool).await;
    let outsider = any_user(&app.pool).await;
    let challenge = seed_challenge(&app.pool, &ann, -1, 5, &[&ben]).await;
    let ended = seed_challenge(&app.pool, &ann, -9, 5, &[&ben]).await;

    let res = app.call(&ann, "POST", &path(&challenge, "/leave"), None).await;
    res.assert_error(409, c::ERR_CODE_CREATOR_CANNOT_LEAVE, "The creator cannot leave the challenge");
    let res = app.call(&ben, "POST", &path(&ended, "/leave"), None).await;
    res.assert_error(409, c::ERR_CODE_CHALLENGE_ENDED, "This challenge has ended");
    app.call(&outsider, "POST", &path(&challenge, "/leave"), None)
        .await
        .assert_error_code(404, c::ERR_CODE_CHALLENGE_NOT_FOUND);
    app.call(&ben, "POST", "/api/challenges/0/leave", None).await.assert_error_code(400, c::ERR_CODE_INVALID_REQUEST);
    let res = app.call(&ben, "POST", "/api/challenges/%31/leave", None).await;
    res.assert_error(400, c::ERR_CODE_INVALID_REQUEST, "Invalid challenge ID"); // ids are not unescaped

    let res = app.call(&ben, "POST", &path(&challenge, "/leave"), None).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true}"#));
    let left =
        count(&app.pool, "challenge_participants", "challenge_id = $1 AND user_id = $2", &[challenge.id, ben.id]).await;
    assert_eq!(left, 0);
}

async fn cheer_participant(db: &TestDb) {
    let app = App::new(db);
    let ann = user(&app.pool, "ann").await;
    let ben = any_user(&app.pool).await;
    let outsider = any_user(&app.pool).await;
    let challenge = seed_challenge(&app.pool, &ann, -1, 5, &[&ben]).await;
    let upcoming = seed_challenge(&app.pool, &ann, 2, 5, &[&ben]).await;
    let cheers = path(&challenge, "/cheers");

    let res = app.call(&ann, "POST", &cheers, Some(json!({"user_id": ben.id}))).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true,"already_cheered":false}"#));
    let notifs = notifications(&app.pool, ben.id, NOTIF_TYPE_CHALLENGE_CHEER).await;
    assert_eq!(notifs[0].body, "ann cheered you on in “Study 2h+”");

    let res = app.call(&ann, "POST", &cheers, Some(json!({"user_id": ben.id}))).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true,"already_cheered":true}"#));
    assert_eq!(notifications(&app.pool, ben.id, NOTIF_TYPE_CHALLENGE_CHEER).await.len(), 1);

    let not_participant = (400, c::ERR_CODE_INVALID_CHALLENGE, "user_id must be a participant of this challenge");
    let invalid_body = (400, c::ERR_CODE_INVALID_REQUEST, "Invalid request body");
    let required = (400, c::ERR_CODE_INVALID_REQUEST, "user_id is required");
    let tests: Vec<BodyCase> = vec![
        (
            "self",
            &ann,
            cheers.clone(),
            json!({"user_id": ann.id}).to_string(),
            (400, c::ERR_CODE_CANNOT_CHEER_SELF, "You cannot cheer yourself"),
        ),
        ("not a participant", &ann, cheers.clone(), json!({"user_id": outsider.id}).to_string(), not_participant),
        (
            "beyond int64 (verified against Go)",
            &ann,
            cheers.clone(),
            r#"{"user_id":18446744073709551615}"#.into(),
            not_participant,
        ),
        (
            "not active",
            &ann,
            path(&upcoming, "/cheers"),
            json!({"user_id": ben.id}).to_string(),
            (409, c::ERR_CODE_CHALLENGE_NOT_ACTIVE, "You can only cheer while the challenge is active"),
        ),
        (
            "outsider",
            &outsider,
            cheers.clone(),
            json!({"user_id": ben.id}).to_string(),
            (404, c::ERR_CODE_CHALLENGE_NOT_FOUND, "Challenge not found"),
        ),
        ("missing user_id", &ann, cheers.clone(), "{}".into(), required),
        ("null body", &ann, cheers.clone(), "null".into(), required),
        ("malformed body", &ann, cheers.clone(), r#"{"user_id":"ben"}"#.into(), invalid_body),
        ("negative", &ann, cheers.clone(), r#"{"user_id":-1}"#.into(), invalid_body),
        ("fraction", &ann, cheers.clone(), r#"{"user_id":1.0}"#.into(), invalid_body),
        ("empty body", &ann, cheers.clone(), String::new(), invalid_body),
        (
            "invalid ID",
            &ann,
            "/api/challenges/abc/cheers".into(),
            json!({"user_id": ben.id}).to_string(),
            (400, c::ERR_CODE_INVALID_REQUEST, "Invalid challenge ID"),
        ),
    ];
    for (name, u, uri, body, (status, code, message)) in tests {
        let res = app.raw(Some(u.id), "POST", &uri, Some(&body)).await;
        assert_eq!(res.status, status, "{name}: {}", res.body);
        res.assert_error(status, code, message);
    }
}

async fn get_invite_candidates(db: &TestDb) {
    let app = App::new(db);
    let ann = user(&app.pool, "ann").await;
    let ben = user(&app.pool, "ben").await;
    let amy = user_with_avatar(&app.pool, "amy").await;
    let abe = user(&app.pool, "abe").await;
    let outsider = user(&app.pool, "zed").await;
    follow(&app.pool, &ann, &amy, FOLLOW_STATE_ACTIVE).await;
    follow(&app.pool, &abe, &ann, FOLLOW_STATE_ACTIVE).await;
    follow(&app.pool, &ann, &ben, FOLLOW_STATE_ACTIVE).await;
    let challenge = seed_challenge(&app.pool, &ann, 1, 5, &[&ben]).await;
    invite(&app.pool, &challenge, &ann, &abe, app.clock.now()).await;
    let uri = path(&challenge, "/invite-candidates");

    let body = app.call(&ann, "GET", &uri, None).await.assert_ok(200);
    let users = body["users"].as_array().unwrap();
    assert_eq!(users.len(), 2);
    assert_eq!(keys(&users[0]), sorted(&[USER_KEYS, &["invited"]].concat()));
    assert_eq!(
        body,
        json!({"success": true, "users": [
            {"id": abe.id, "username": "abe", "profile_pic": null, "profile_pic_thumb": null, "is_verified": false, "invited": true},
            {"id": amy.id, "username": "amy", "profile_pic": amy.profile_pic, "profile_pic_thumb": amy.profile_pic_thumb, "is_verified": true, "invited": false},
        ]})
    );

    let body = app.call(&ann, "GET", &format!("{uri}?q=AM&limit=100"), None).await.assert_ok(200);
    assert_eq!(body["users"].as_array().unwrap().len(), 1);
    assert_eq!(body["users"][0]["username"], "amy");

    let body = app.call(&ann, "GET", &format!("{uri}?limit=1"), None).await.assert_ok(200);
    assert_eq!(body["users"].as_array().unwrap().len(), 1);
    let body = app.call(&ann, "GET", &format!("{uri}?limit=%2B1"), None).await.assert_ok(200);
    assert_eq!(body["users"].as_array().unwrap().len(), 1, "strconv.Atoi accepts a sign");
    let body = app.call(&ann, "GET", &format!("{uri}?limit="), None).await.assert_ok(200);
    assert_eq!(body["users"].as_array().unwrap().len(), 2, "an empty limit is the default");

    let res = app.call(&ann, "GET", &format!("{uri}?q=nobody"), None).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true,"users":[]}"#));

    for limit in ["abc", "0", "-3", "1.5", "99999999999999999999"] {
        let res = app.call(&ann, "GET", &format!("{uri}?limit={limit}"), None).await;
        res.assert_error(400, c::ERR_CODE_INVALID_REQUEST, "limit must be a positive integer");
    }
    app.call(&outsider, "GET", &uri, None).await.assert_error_code(404, c::ERR_CODE_CHALLENGE_NOT_FOUND);
    app.call(&ann, "GET", "/api/challenges/0/invite-candidates", None)
        .await
        .assert_error_code(400, c::ERR_CODE_INVALID_REQUEST);
}

async fn invite_users(db: &TestDb) {
    let app = App::new(db);
    let ann = user(&app.pool, "ann").await;
    let friend = any_user(&app.pool).await;
    let stranger = any_user(&app.pool).await;
    follow(&app.pool, &friend, &ann, FOLLOW_STATE_ACTIVE).await;
    let challenge = seed_challenge(&app.pool, &ann, 1, 5, &[]).await;
    let ended = seed_challenge(&app.pool, &ann, -9, 5, &[]).await;
    let invites = path(&challenge, "/invites");

    let res = app.call(&ann, "POST", &invites, Some(json!({"user_ids": [friend.id, stranger.id, 99999]}))).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true,"invited":1,"skipped":2}"#));
    let notifs = notifications(&app.pool, friend.id, NOTIF_TYPE_CHALLENGE_INVITE).await;
    assert_eq!(notifs[0].metadata["invite_code"], json!(challenge.invite_code));

    let res = app.call(&ann, "POST", &invites, Some(json!({"user_ids": [friend.id]}))).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true,"invited":0,"skipped":1}"#));
    let res = app.raw(Some(ann.id), "POST", &invites, Some(r#"{"user_ids":[null]}"#)).await;
    assert_eq!(
        (res.status, res.body.as_str()),
        (200, r#"{"success":true,"invited":0,"skipped":1}"#),
        "null decodes as 0"
    );

    let wrong_count = (400, c::ERR_CODE_INVALID_CHALLENGE, "user_ids must contain between 1 and 20 users");
    let invalid_body = (400, c::ERR_CODE_INVALID_REQUEST, "Invalid request body");
    let too_many = json!({"user_ids": vec![0; c::CHALLENGE_MAX_INVITES_PER_REQUEST + 1]}).to_string();
    let friend_body = json!({"user_ids": [friend.id]}).to_string();
    let tests: Vec<BodyCase> = vec![
        ("no users", &ann, invites.clone(), r#"{"user_ids":[]}"#.into(), wrong_count),
        ("missing users", &ann, invites.clone(), "{}".into(), wrong_count),
        ("null users", &ann, invites.clone(), r#"{"user_ids":null}"#.into(), wrong_count),
        ("too many users", &ann, invites.clone(), too_many, wrong_count),
        ("malformed body", &ann, invites.clone(), r#"{"user_ids":"all"}"#.into(), invalid_body),
        ("beyond uint64", &ann, invites.clone(), r#"{"user_ids":[18446744073709551616]}"#.into(), invalid_body),
        // Verified against the Go server: pgx cannot encode the id as int8, so the request fails.
        (
            "beyond int64",
            &ann,
            invites.clone(),
            r#"{"user_ids":[9223372036854775808]}"#.into(),
            (500, c::ERR_CODE_CREATE_FAILED, "Failed to send invites"),
        ),
        (
            "ended",
            &ann,
            path(&ended, "/invites"),
            friend_body.clone(),
            (409, c::ERR_CODE_CHALLENGE_ENDED, "This challenge has ended"),
        ),
        (
            "outsider",
            &stranger,
            invites.clone(),
            friend_body.clone(),
            (404, c::ERR_CODE_CHALLENGE_NOT_FOUND, "Challenge not found"),
        ),
        (
            "invalid ID",
            &ann,
            "/api/challenges/-4/invites".into(),
            friend_body,
            (400, c::ERR_CODE_INVALID_REQUEST, "Invalid challenge ID"),
        ),
    ];
    for (name, u, uri, body, (status, code, message)) in tests {
        let res = app.raw(Some(u.id), "POST", &uri, Some(&body)).await;
        assert_eq!(res.status, status, "{name}: {}", res.body);
        res.assert_error(status, code, message);
    }
    let res = app.raw(Some(ann.id), "POST", &invites, Some(r#"{"user_ids":[9223372036854775807]}"#)).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true,"invited":0,"skipped":1}"#));
}

async fn preview_challenge(db: &TestDb) {
    let app = App::new(db);
    let ann = user(&app.pool, "ann").await;
    let ben = any_user(&app.pool).await;
    let outsider = any_user(&app.pool).await;
    let challenge = seed_challenge(&app.pool, &ann, 2, 7, &[&ben]).await;
    let code = challenge.invite_code.clone();

    let body =
        app.call(&outsider, "GET", &format!("/api/challenge-codes/{}", code.to_lowercase()), None).await.assert_ok(200);
    let preview = &body["preview"];
    assert_eq!(
        keys(preview),
        sorted(&[
            "id",
            "title",
            "activity",
            "goal_type",
            "target_hours",
            "start_date",
            "end_date",
            "duration_days",
            "status",
            "finalized",
            "participant_count",
            "max_participants",
            "creator",
            "participants_preview",
            "is_participant",
            "can_join",
            "join_blocked_reason",
        ])
    );
    assert_eq!(preview["id"], json!(challenge.id));
    assert_eq!(preview["status"], "upcoming");
    assert_eq!(preview["participant_count"], json!(2));
    assert_eq!(preview["max_participants"], json!(50));
    assert_eq!(preview["creator"]["username"], "ann");
    assert_eq!(preview["participants_preview"].as_array().unwrap().len(), 2);
    assert_eq!(preview["is_participant"], json!(false));
    assert_eq!(preview["can_join"], json!(true));
    assert_eq!(preview["join_blocked_reason"], Value::Null);

    let body = app.call(&ben, "GET", &format!("/api/challenge-codes/{code}"), None).await.assert_ok(200);
    assert_eq!((&body["preview"]["is_participant"], &body["preview"]["can_join"]), (&json!(true), &json!(false)));

    let ended = seed_challenge(&app.pool, &ann, -9, 5, &[]).await;
    let body =
        app.call(&outsider, "GET", &format!("/api/challenge-codes/{}", ended.invite_code), None).await.assert_ok(200);
    assert_eq!(body["preview"]["join_blocked_reason"], "ended");

    // Malformed codes, including escapes the router leaves to the handler (verified against Go).
    for raw in [
        "ABC",
        "ABCDEFG0",
        "ABCDEFGHJ",
        "ABCD%20EFG",
        "%ZZ",
        "ABCD%2FEFG",
        &format!("+{code}"),
        "%C3",
        &format!("%25{code}"),
    ] {
        let res = app.call(&outsider, "GET", &format!("/api/challenge-codes/{raw}"), None).await;
        res.assert_error(400, c::ERR_CODE_INVALID_REQUEST, "Invalid invite code");
    }
    let res = app.call(&outsider, "GET", &format!("/api/challenge-codes/%20{}%20", code.to_lowercase()), None).await;
    assert_eq!(res.status, 200, "surrounding spaces are ignored");
    let escaped = format!("/api/challenge-codes/%{:02X}{}", code.as_bytes()[0], &code[1..]);
    assert_eq!(app.call(&outsider, "GET", &escaped, None).await.status, 200, "escapes are decoded");
    let res = app.call(&outsider, "GET", "/api/challenge-codes/ZZZZZZZZ", None).await;
    res.assert_error(404, c::ERR_CODE_CHALLENGE_NOT_FOUND, "Challenge not found");
}

async fn join_challenge(db: &TestDb) {
    let app = App::new(db);
    let ann = user(&app.pool, "ann").await;
    let ben = user(&app.pool, "ben").await;
    let challenge = seed_challenge(&app.pool, &ann, 1, 5, &[]).await;

    let uri = format!("/api/challenge-codes/{}/join", challenge.invite_code.to_lowercase());
    let body = app.call(&ben, "POST", &uri, None).await.assert_ok(200);
    assert_detail_shape(&body["challenge"]);
    assert_eq!(body["challenge"]["participant_count"], json!(2));
    assert_eq!(body["challenge"]["can_leave"], json!(true));
    let notifs = notifications(&app.pool, ann.id, NOTIF_TYPE_CHALLENGE_JOINED).await;
    assert_eq!(notifs[0].body, "ben joined “Study 2h+”");

    let res = app.call(&ben, "POST", &format!("/api/challenge-codes/{}/join", challenge.invite_code), None).await;
    assert_eq!(res.status, 200, "joining again succeeds");
    assert_eq!(notifications(&app.pool, ann.id, NOTIF_TYPE_CHALLENGE_JOINED).await.len(), 1);

    let ended = seed_challenge(&app.pool, &ann, -9, 5, &[]).await;
    let full = seed_challenge(&app.pool, &ann, 1, 5, &[]).await;
    for _ in 1..c::CHALLENGE_MAX_PARTICIPANTS {
        let member = any_user(&app.pool).await;
        join(&app.pool, &full, &member, cday()).await;
    }
    let busy = any_user(&app.pool).await;
    for _ in 0..c::CHALLENGE_MAX_OPEN_PER_USER {
        seed_challenge(&app.pool, &busy, 1, 5, &[]).await;
    }

    let tests = [
        ("ended", &ben, ended.invite_code.as_str(), 409, c::ERR_CODE_CHALLENGE_ENDED, "This challenge has ended"),
        ("full", &ben, full.invite_code.as_str(), 409, c::ERR_CODE_CHALLENGE_FULL, "This challenge is full"),
        (
            "limit",
            &busy,
            challenge.invite_code.as_str(),
            409,
            c::ERR_CODE_CHALLENGE_LIMIT_REACHED,
            "You already take part in the maximum number of open challenges",
        ),
        ("unknown", &ben, "ZZZZZZZZ", 404, c::ERR_CODE_CHALLENGE_NOT_FOUND, "Challenge not found"),
        ("malformed", &ben, "nope", 400, c::ERR_CODE_INVALID_REQUEST, "Invalid invite code"),
    ];
    for (name, u, code, status, error_code, message) in tests {
        let res = app.call(u, "POST", &format!("/api/challenge-codes/{code}/join"), None).await;
        assert_eq!(res.status, status, "{name}: {}", res.body);
        res.assert_error(status, error_code, message);
    }
}

async fn server_errors(db: &TestDb) {
    let ann = any_user(&db.pool).await;
    let ben = any_user(&db.pool).await;
    let challenge = seed_challenge(&db.pool, &ann, -1, 5, &[&ben]).await;
    let broken = db.broken_pool().await;
    let app = App::with_challenges(db, &broken);
    let code = challenge.invite_code.clone();
    let (logs, _guard) = LogCapture::start();

    let tests: [(&str, String, Option<Value>, &str, &str); 10] = [
        ("GET", "/api/challenges".into(), None, c::ERR_CODE_FETCH_FAILED, "Failed to load challenges"),
        (
            "POST",
            "/api/challenges".into(),
            Some(create_body(1, 5)),
            c::ERR_CODE_CREATE_FAILED,
            "Failed to create challenge",
        ),
        ("GET", path(&challenge, ""), None, c::ERR_CODE_FETCH_FAILED, "Failed to load challenge"),
        ("DELETE", path(&challenge, ""), None, c::ERR_CODE_DELETE_FAILED, "Failed to delete challenge"),
        ("POST", path(&challenge, "/leave"), None, c::ERR_CODE_DELETE_FAILED, "Failed to leave challenge"),
        (
            "POST",
            path(&challenge, "/cheers"),
            Some(json!({"user_id": ben.id})),
            c::ERR_CODE_CREATE_FAILED,
            "Failed to cheer",
        ),
        (
            "GET",
            path(&challenge, "/invite-candidates"),
            None,
            c::ERR_CODE_FETCH_FAILED,
            "Failed to load invite candidates",
        ),
        (
            "POST",
            path(&challenge, "/invites"),
            Some(json!({"user_ids": [ben.id]})),
            c::ERR_CODE_CREATE_FAILED,
            "Failed to send invites",
        ),
        ("GET", format!("/api/challenge-codes/{code}"), None, c::ERR_CODE_FETCH_FAILED, "Failed to load challenge"),
        (
            "POST",
            format!("/api/challenge-codes/{code}/join"),
            None,
            c::ERR_CODE_CREATE_FAILED,
            "Failed to join challenge",
        ),
    ];
    for (method, uri, body, error_code, message) in tests {
        let res = app.call(&ann, method, &uri, body).await;
        assert_eq!(res.status, 500, "{method} {uri}: {}", res.body);
        res.assert_error(500, error_code, message);
    }

    let entries = logs.with_message("Failed to load challenge");
    assert_eq!(entries.len(), 2, "detail and preview");
    let fields = &entries[0].fields;
    assert_eq!(fields["challenge_id"], challenge.id.to_string());
    assert_eq!(fields["user_id"], ann.id.to_string());
    assert!(!fields["error"].is_empty());
    assert_eq!(fields["action"], "responded with 500; the client may retry");
    assert_eq!(entries[1].fields["challenge_id"], "0", "code routes log no challenge id");
}

/// Reads use the API limiter and writes the challenge write limiter; a method without a
/// handler is answered by the router without authentication.
async fn guards_and_limiters(db: &TestDb) {
    let app = App::new(db);
    let ann = any_user(&app.pool).await;
    let challenge = seed_challenge(&app.pool, &ann, 1, 5, &[]).await;

    let limit = |res: &Res| res.headers["x-ratelimit-limit"].to_str().unwrap().to_string();
    let read = app.call(&ann, "GET", &path(&challenge, ""), None).await;
    assert_eq!(limit(&read), c::RATE_LIMIT_API_MAX_REQUESTS.to_string());
    let write = app.call(&ann, "POST", &path(&challenge, "/cheers"), Some(json!({}))).await;
    assert_eq!(limit(&write), c::RATE_LIMIT_CHALLENGE_WRITE_MAX_REQUESTS.to_string());

    for _ in 1..c::RATE_LIMIT_CHALLENGE_WRITE_MAX_REQUESTS {
        app.call(&ann, "POST", "/api/challenge-codes/nope/join", None).await;
    }
    let res = app.call(&ann, "POST", "/api/challenge-codes/nope/join", None).await;
    res.assert_error(429, c::ERR_CODE_RATE_LIMIT_EXCEEDED, c::MSG_RATE_LIMIT_CHALLENGE_WRITE);
    let res = app.call(&ann, "GET", &path(&challenge, ""), None).await;
    assert_eq!(res.status, 200, "reads have their own limiter");

    let res = app.raw(None, "PUT", "/api/challenges", None).await;
    assert_eq!(res.status, 405, "no authentication for a method without a handler");
    let res = app.raw(None, "PATCH", &path(&challenge, ""), None).await;
    assert_eq!(res.status, 405);
}
