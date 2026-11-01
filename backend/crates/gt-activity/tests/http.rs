//! HTTP tests: a scenario replayed against the Go server (expected bodies copied from its
//! responses) and ports of `internal/handlers/{activity,streak,analytics,tile_config,like,badge}_test.go`.

mod common;

use chrono::Utc;
use common::{
    broken_pool, create_user, day, error_body, insert_activity, insert_photo, insert_streak, photo_label, router_with,
    send, Stack, TestDb,
};
use gt_activity::ActivityContext;
use gt_core::gojson;
use gt_core::models::{User, NOTIF_TYPE_LIKE_RECEIVED, NOTIF_TYPE_STREAK_MILESTONE};
use gt_notify::NotifyContext;
use gt_users::UsersContext;
use serde_json::{json, Value};

/// A caller whose account does not exist (Go tests: `ghostUser`).
fn ghost() -> User {
    User {
        id: 999_999,
        email: String::new(),
        username: "ghost".into(),
        password_hash: String::new(),
        profile_pic: None,
        profile_pic_thumb: None,
        bio: None,
        is_private: false,
        is_verified: false,
        email_verified: false,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

/// Contexts whose database is unreachable.
struct Broken {
    users: UsersContext,
    notify: NotifyContext,
    activity: ActivityContext,
}

async fn broken(good: &Stack) -> Broken {
    let core = common::core(&broken_pool().await);
    let users = UsersContext::new(&core);
    let notify = NotifyContext::new(&core);
    let activity = ActivityContext::new(&core, &good.users, &good.notify);
    Broken { users, notify, activity }
}

const OK_ACTIVITY: &str = r#"{"success":true,"message":"Activity updated successfully"}"#;
const OK_TILES: &str = r#"{"success":true,"message":"Tile configuration saved successfully"}"#;

fn encode(value: Value) -> String {
    value.to_string()
}

/// Replays the scenario run against the Go server; every body is the Go server's response,
/// except where noted.
#[tokio::test]
async fn go_parity_scenario() {
    let Some(db) = TestDb::new("http_go_parity").await else { return };
    let pool = &db.pool;
    db.start_user_ids_at(881_000_001).await;
    let stack = Stack::new(pool);
    let app = stack.router();
    let alice = create_user(&stack, "alice", false).await;
    let bob = create_user(&stack, "bob", false).await;
    let carol = create_user(&stack, "carol", true).await;
    sqlx::query("UPDATE users SET profile_pic = 'http://p/b.jpg', profile_pic_thumb = 'http://p/b_t.jpg', is_verified = true WHERE id = $1")
        .bind(bob.id)
        .execute(pool)
        .await
        .unwrap();
    let a = |method: &'static str, path: &'static str, body: Option<String>| {
        let (app, stack, alice) = (app.clone(), &stack, alice.clone());
        async move { send(&app, stack, &alice, method, path, body.as_deref()).await }
    };
    let b = |method: &'static str, path: &'static str, body: Option<String>| {
        let (app, stack, bob) = (app.clone(), &stack, bob.clone());
        async move { send(&app, stack, &bob, method, path, body.as_deref()).await }
    };
    let activity = |name: &str, hours: Value, date: &str| {
        encode(json!({"username": "alice", "activity": name, "hours": hours, "date": date}))
    };

    let cases: Vec<(&str, (u16, String), u16, &str)> = vec![
        ("ca_malformed", a("POST", "/api/create-activity", Some(r#"{"username":"#.into())).await, 400, r#"{"success":false,"error":"Invalid request body","error_code":"INVALID_REQUEST"}"#),
        ("ca_text_plain", a("POST", "/api/create-activity", None).await, 400, r#"{"success":false,"error":"Invalid request body","error_code":"INVALID_REQUEST"}"#),
        ("ca_missing", a("POST", "/api/create-activity", Some(encode(json!({"username": "", "activity": "study", "hours": 1, "date": "2026-03-09"})))).await, 400, r#"{"success":false,"error":"Invalid request body","error_code":"MISSING_FIELDS"}"#),
        ("ca_null_hours", a("POST", "/api/create-activity", Some(encode(json!({"username": "alice", "activity": "study", "hours": null, "date": "2026-03-01"})))).await, 200, OK_ACTIVITY),
        ("ca_hours_overflow", a("POST", "/api/create-activity", Some(r#"{"username":"alice","activity":"study","hours":1e39,"date":"2026-03-01"}"#.into())).await, 400, r#"{"success":false,"error":"Invalid request body","error_code":"INVALID_REQUEST"}"#),
        ("ca_hours_25", a("POST", "/api/create-activity", Some(activity("study", json!(25), "2026-03-01"))).await, 400, r#"{"success":false,"error":"Total hours cannot be more than 24","error_code":"HOURS_EXCEEDED"}"#),
        ("ca_other_user", a("POST", "/api/create-activity", Some(encode(json!({"username": "bob", "activity": "study", "hours": 1, "date": "2026-03-09"})))).await, 400, r#"{"success":false,"error":"You are not authorized to create activity for this username","error_code":"NOT_AUTHORIZED"}"#),
        ("ca_bad_activity", a("POST", "/api/create-activity", Some(activity("Study", json!(1), "2026-03-09"))).await, 400, r#"{"success":false,"error":"Invalid activity name","error_code":"INVALID_ACTIVITY"}"#),
        ("ca_long_note", a("POST", "/api/create-activity", Some(encode(json!({"username": "alice", "activity": "study", "hours": 1, "date": "2026-03-09", "note": "x".repeat(501)})))).await, 400, r#"{"success":false,"error":"Note must be 500 characters or less","error_code":"INVALID_REQUEST"}"#),
        ("ca_bad_date", a("POST", "/api/create-activity", Some(activity("study", json!(1), "2026-02-30"))).await, 400, r#"{"success":false,"error":"Invalid date format, use YYYY-MM-DD","error_code":"INVALID_DATE"}"#),
    ];
    for (name, (status, body), want_status, want_body) in cases {
        assert_eq!((status, body.as_str()), (want_status, want_body), "{name}");
    }

    for (name, hours, date, note) in [
        ("study", json!(2.675), "2026-03-09", Some("<b>&")),
        ("sleep", json!(8), "2026-03-09", None),
        ("workout", json!(1), "2026-03-09", Some("")),
        ("reels", json!(1), "2026-03-09", None),
        ("family", json!(1), "2026-03-09", None),
        ("eating", json!(0.1), "2026-03-10", None),
        ("idle", json!(0.7), "2026-03-10", None),
        ("rest", json!(0), "2026-03-11", None),
        ("study", json!(7), "2026-03-06", None),
        ("custom:123e4567-e89b-12d3-a456-426614174000", json!(1.5), "2026-03-15", None),
    ] {
        let mut body = json!({"username": "alice", "activity": name, "hours": hours, "date": date});
        if let Some(note) = note {
            body["note"] = json!(note);
        }
        assert_eq!(
            a("POST", "/api/create-activity", Some(encode(body))).await,
            (200, OK_ACTIVITY.to_string()),
            "{name} {date}"
        );
    }

    let range = |user: &str, start: &str, end: &str| {
        Some(encode(json!({"username": user, "start_date": start, "end_date": end})))
    };
    let cases: Vec<(&str, (u16, String), u16, &str)> = vec![
        (
            "ca_exceeded",
            a("POST", "/api/create-activity", Some(activity("office", json!(12), "2026-03-09"))).await,
            400,
            r#"{"success":false,"error":"Total hours cannot be more than 24","error_code":"HOURS_EXCEEDED"}"#,
        ),
        (
            "ga_own",
            a("POST", "/api/get-activities", range("alice", "2026-03-09", "2026-03-15")).await,
            200,
            r#"{"success":true,"data":[{"id":2,"name":"study","hours":2.67,"date":"2026-03-09","note":"\u003cb\u003e\u0026"},{"id":3,"name":"sleep","hours":8,"date":"2026-03-09"},{"id":4,"name":"workout","hours":1,"date":"2026-03-09","note":""},{"id":5,"name":"reels","hours":1,"date":"2026-03-09"},{"id":6,"name":"family","hours":1,"date":"2026-03-09"},{"id":7,"name":"eating","hours":0.1,"date":"2026-03-10"},{"id":8,"name":"idle","hours":0.7,"date":"2026-03-10"},{"id":9,"name":"rest","hours":0,"date":"2026-03-11"},{"id":11,"name":"custom:123e4567-e89b-12d3-a456-426614174000","hours":1.5,"date":"2026-03-15"}]}"#,
        ),
        (
            "ga_other",
            b("POST", "/api/get-activities", range("alice", "2026-03-09", "2026-03-09")).await,
            200,
            r#"{"success":true,"data":[{"id":2,"name":"study","hours":2.67,"date":"2026-03-09"},{"id":3,"name":"sleep","hours":8,"date":"2026-03-09"},{"id":4,"name":"workout","hours":1,"date":"2026-03-09"},{"id":5,"name":"reels","hours":1,"date":"2026-03-09"},{"id":6,"name":"family","hours":1,"date":"2026-03-09"}]}"#,
        ),
        (
            "ga_empty",
            b("POST", "/api/get-activities", range("alice", "2025-01-01", "2025-01-02")).await,
            200,
            r#"{"success":true,"data":[]}"#,
        ),
        (
            "ga_private",
            b("POST", "/api/get-activities", range("carol", "2026-03-09", "2026-03-09")).await,
            403,
            r#"{"success":false,"error":"This account is private","error_code":"ACCOUNT_PRIVATE"}"#,
        ),
        (
            "ga_unknown",
            b("POST", "/api/get-activities", range("nobody", "2026-03-09", "2026-03-09")).await,
            400,
            r#"{"success":false,"error":"Failed to find user","error_code":"USER_NOT_FOUND"}"#,
        ),
        (
            "ga_range",
            b("POST", "/api/get-activities", range("alice", "2026-03-10", "2026-03-09")).await,
            400,
            r#"{"success":false,"error":"Start date must be before end date","error_code":"INVALID_DATE_RANGE"}"#,
        ),
        (
            "dt_sum",
            b("POST", "/api/get-daily-totals", range("alice", "2026-03-01", "2026-03-31")).await,
            200,
            r#"{"success":true,"data":{"2026-03-01":0,"2026-03-06":7,"2026-03-09":13.67,"2026-03-10":0.8,"2026-03-11":0,"2026-03-15":1.5}}"#,
        ),
        (
            "dt_empty",
            b("POST", "/api/get-daily-totals", range("alice", "2025-03-01", "2025-03-31")).await,
            200,
            r#"{"success":true,"data":{}}"#,
        ),
        (
            "dt_too_long",
            b("POST", "/api/get-daily-totals", range("alice", "2026-01-01", "2026-04-05")).await,
            400,
            r#"{"success":false,"error":"Date range cannot exceed 93 days","error_code":"INVALID_DATE_RANGE"}"#,
        ),
        // Go's activity_summary orders equal totals randomly (map iteration); this is one of its
        // possible orders (the Go run printed reels, workout, family).
        (
            "wa",
            b(
                "POST",
                "/api/get-week-analytics",
                Some(encode(json!({"username": "alice", "week_start": "2026-03-09"}))),
            )
            .await,
            200,
            r#"{"success":true,"total_hours_this_week":15.97,"total_hours_prev_week":7,"total_hours_current_week":0,"percentage_change":128.14285,"percentage_vs_current":100,"is_current_week":false,"streak":{"current":0,"longest":0},"daily_breakdown":[{"date":"2026-03-09","day_name":"Mon","total_hours":13.67,"activities":[{"name":"sleep","hours":8},{"name":"study","hours":2.67},{"name":"workout","hours":1},{"name":"reels","hours":1},{"name":"family","hours":1}]},{"date":"2026-03-10","day_name":"Tue","total_hours":0.8,"activities":[{"name":"idle","hours":0.7},{"name":"eating","hours":0.1}]},{"date":"2026-03-11","day_name":"Wed","total_hours":0,"activities":[]},{"date":"2026-03-12","day_name":"Thu","total_hours":0,"activities":[]},{"date":"2026-03-13","day_name":"Fri","total_hours":0,"activities":[]},{"date":"2026-03-14","day_name":"Sat","total_hours":0,"activities":[]},{"date":"2026-03-15","day_name":"Sun","total_hours":1.5,"activities":[{"name":"custom:123e4567-e89b-12d3-a456-426614174000","hours":1.5}]}],"activity_summary":[{"name":"sleep","total_hours":8},{"name":"study","total_hours":2.67},{"name":"custom:123e4567-e89b-12d3-a456-426614174000","total_hours":1.5},{"name":"workout","total_hours":1},{"name":"reels","total_hours":1},{"name":"family","total_hours":1},{"name":"idle","total_hours":0.7},{"name":"eating","total_hours":0.1}]}"#,
        ),
        (
            "wa_bad",
            b("POST", "/api/get-week-analytics", Some(encode(json!({"username": "alice", "week_start": "2026-W11"}))))
                .await,
            400,
            r#"{"success":false,"error":"Invalid week_start format, use YYYY-MM-DD","error_code":"INVALID_DATE"}"#,
        ),
    ];
    for (name, (status, body), want_status, want_body) in cases {
        assert_eq!((status, body.as_str()), (want_status, want_body), "{name}");
    }
    let stored: Vec<(String, String)> =
        sqlx::query_as("SELECT name, duration_hours::text FROM activities ORDER BY id").fetch_all(pool).await.unwrap();
    let stored: Vec<String> = stored.into_iter().map(|(n, h)| format!("{n}={h}")).collect();
    assert_eq!(
        stored.join(" "),
        "study=0.00 study=2.67 sleep=8.00 workout=1.00 reels=1.00 family=1.00 eating=0.10 idle=0.70 rest=0.00 study=7.00 \
         custom:123e4567-e89b-12d3-a456-426614174000=1.50"
    );

    insert_streak(pool, alice.id, 8, 8, day(2026, 3, 9)).await;
    // New badges carry the date of Go's `time.Now()` (process time zone).
    let earned = gt_core::timeutil::format_date(&gt_core::timeutil::today_local());
    let streak = |user: &str, date: &str| Some(encode(json!({"username": user, "date": date})));
    let gs_own = format!(
        r##"{{"success":true,"data":{{"id":1,"current":8,"longest":8,"date":"2026-03-09","new_badges":[{{"key":"first_step","name":"First Step","icon":"Footprints","color":"#22c55e","threshold":1,"earned":false,"earned_at":"{earned}"}},{{"key":"spark_starter","name":"Spark Starter","icon":"Zap","color":"#3b82f6","threshold":7,"earned":false,"earned_at":"{earned}"}}]}}}}"##
    );
    let badges = format!(
        r##"{{"success":true,"badges":[{{"key":"first_step","name":"First Step","icon":"Footprints","color":"#22c55e","threshold":1,"earned":true,"earned_at":"{earned}"}},{{"key":"spark_starter","name":"Spark Starter","icon":"Zap","color":"#3b82f6","threshold":7,"earned":true,"earned_at":"{earned}"}},{{"key":"flame_keeper","name":"Flame Keeper","icon":"Flame","color":"#f97316","threshold":15,"earned":false}},{{"key":"iron_will","name":"Iron Will","icon":"Shield","color":"#64748b","threshold":30,"earned":false}},{{"key":"diamond_mind","name":"Diamond Mind","icon":"Gem","color":"#06b6d4","threshold":90,"earned":false}},{{"key":"titan","name":"Titan","icon":"Crown","color":"#a855f7","threshold":120,"earned":false}},{{"key":"legendary","name":"Legendary","icon":"Star","color":"#eab308","threshold":360,"earned":false}}]}}"##
    );
    let tc_data = r##"{"big":12345678901234567000,"customTiles":[{"color":"#fff","icon":"Music","id":"123e4567-e89b-12d3-a456-426614174000","name":"Guitar"}],"e":1e+21,"f":0.1,"n":1,"nested":{"a":[2.5,true,null],"z":1},"order":["study",null],"s":"\u003c\u0026\u003e","sizes":{"study":"large"}}"##;
    let tc_full = format!(r#"{{"success":true,"data":{tc_data}}}"#);
    let cases: Vec<(&str, (u16, String), u16, &str)> = vec![
        ("gs_other", b("POST", "/api/get-streak", streak("alice", "2026-03-09")).await, 200, r#"{"success":true,"data":{"id":1,"current":8,"longest":8,"date":"2026-03-09"}}"#),
        ("gs_own", a("POST", "/api/get-streak", streak("alice", "2026-03-09")).await, 200, gs_own.as_str()),
        ("gs_own_again", a("POST", "/api/get-streak", streak("alice", "2026-03-09")).await, 200, r#"{"success":true,"data":{"id":1,"current":8,"longest":8,"date":"2026-03-09"}}"#),
        ("gs_missing", a("POST", "/api/get-streak", streak("alice", "2026-03-10")).await, 400, r#"{"success":false,"error":"Failed to find streak","error_code":"STREAK_NOT_FOUND"}"#),
        ("badges", a("GET", "/api/badges", None).await, 200, badges.as_str()),
        ("badges_user", b("POST", "/api/badges/user", Some(r#"{"username":"carol"}"#.into())).await, 200, r##"{"success":true,"badges":[{"key":"first_step","name":"First Step","icon":"Footprints","color":"#22c55e","threshold":1,"earned":false},{"key":"spark_starter","name":"Spark Starter","icon":"Zap","color":"#3b82f6","threshold":7,"earned":false},{"key":"flame_keeper","name":"Flame Keeper","icon":"Flame","color":"#f97316","threshold":15,"earned":false},{"key":"iron_will","name":"Iron Will","icon":"Shield","color":"#64748b","threshold":30,"earned":false},{"key":"diamond_mind","name":"Diamond Mind","icon":"Gem","color":"#06b6d4","threshold":90,"earned":false},{"key":"titan","name":"Titan","icon":"Crown","color":"#a855f7","threshold":120,"earned":false},{"key":"legendary","name":"Legendary","icon":"Star","color":"#eab308","threshold":360,"earned":false}]}"##),
        ("badges_unknown", b("POST", "/api/badges/user", Some(r#"{"username":"nobody"}"#.into())).await, 400, r#"{"success":false,"error":"Failed to find user","error_code":"USER_NOT_FOUND"}"#),
        ("tc_none", a("GET", "/api/tile-config", None).await, 200, r#"{"success":true,"data":null}"#),
        ("tc_bad_shape", a("POST", "/api/tile-config", Some(r#"{"config":[1]}"#.into())).await, 400, r#"{"success":false,"error":"Invalid request body","error_code":"INVALID_REQUEST"}"#),
        ("tc_bad_order", a("POST", "/api/tile-config", Some(r#"{"config":{"order":"x"}}"#.into())).await, 400, r#"{"success":false,"error":"Invalid configuration format","error_code":"INVALID_TILE_CONFIG"}"#),
        ("tc_null_tile", a("POST", "/api/tile-config", Some(r#"{"config":{"customTiles":[null]}}"#.into())).await, 400, r#"{"success":false,"error":"custom tile ID is required","error_code":"INVALID_TILE_CONFIG"}"#),
        ("tc_bad_color", a("POST", "/api/tile-config", Some(r#"{"config":{"colors":{"a":"red"}}}"#.into())).await, 400, r#"{"success":false,"error":"Invalid color format: red","error_code":"INVALID_COLOR"}"#),
        ("tc_save", a("POST", "/api/tile-config", Some(r##"{"config":{"order":["study",null],"sizes":{"study":"large"},"n":1.0,"big":12345678901234567890,"e":1e21,"f":0.1,"s":"<&>","nested":{"z":1,"a":[2.50,true,null]},"customTiles":[{"id":"123e4567-e89b-12d3-a456-426614174000","name":"Guitar","icon":"Music","color":"#fff"}]}}"##.into())).await, 200, OK_TILES),
        ("tc_get", a("GET", "/api/tile-config", None).await, 200, tc_full.as_str()),
        ("tc_user", b("POST", "/api/tile-config/user", Some(r#"{"username":"alice"}"#.into())).await, 200, tc_full.as_str()),
        ("tc_user_missing", b("POST", "/api/tile-config/user", Some(r#"{"username":""}"#.into())).await, 400, r#"{"success":false,"error":"Username is required","error_code":"MISSING_FIELDS"}"#),
        ("tc_user_unknown", b("POST", "/api/tile-config/user", Some(r#"{"username":"nobody"}"#.into())).await, 404, r#"{"success":false,"error":"User not found","error_code":"USER_NOT_FOUND"}"#),
        ("tc_user_private", b("POST", "/api/tile-config/user", Some(r#"{"username":"carol"}"#.into())).await, 403, r#"{"success":false,"error":"This account is private","error_code":"ACCOUNT_PRIVATE"}"#),
        ("tc_save_null", b("POST", "/api/tile-config", Some(r#"{"config":null}"#.into())).await, 200, OK_TILES),
        ("tc_get_null", b("GET", "/api/tile-config", None).await, 200, r#"{"success":true,"data":null}"#),
    ];
    for (name, (status, body), want_status, want_body) in cases {
        assert_eq!((status, body.as_str()), (want_status, want_body), "{name}");
    }
    let stored: Vec<Option<String>> =
        sqlx::query_scalar("SELECT config::text FROM tile_configs ORDER BY id").fetch_all(pool).await.unwrap();
    assert_eq!(
        stored,
        vec![
            Some(r##"{"e": 1000000000000000000000, "f": 0.1, "n": 1, "s": "<&>", "big": 12345678901234567000, "order": ["study", null], "sizes": {"study": "large"}, "nested": {"a": [2.5, true, null], "z": 1}, "customTiles": [{"id": "123e4567-e89b-12d3-a456-426614174000", "icon": "Music", "name": "Guitar", "color": "#fff"}]}"##.to_string()),
            None
        ]
    );

    let like = |user: &str, date: &str| Some(encode(json!({"username": user, "date": date})));
    let cases: Vec<(&str, (u16, String), u16, &str)> = vec![
        (
            "like_missing",
            b("POST", "/api/like-day", like("alice", "")).await,
            400,
            r#"{"success":false,"error":"Username and date are required","error_code":"MISSING_FIELDS"}"#,
        ),
        (
            "like_private",
            b("POST", "/api/like-day", like("carol", "2026-03-09")).await,
            403,
            r#"{"success":false,"error":"Cannot like a private account's day","error_code":"ACCOUNT_PRIVATE"}"#,
        ),
        (
            "like",
            b("POST", "/api/like-day", like("alice", "2026-03-09")).await,
            200,
            r#"{"success":true,"liked":true,"new_count":1}"#,
        ),
        (
            "like_again",
            b("POST", "/api/like-day", like("alice", "2026-03-09")).await,
            200,
            r#"{"success":true,"liked":true,"new_count":1}"#,
        ),
    ];
    for (name, (status, body), want_status, want_body) in cases {
        assert_eq!((status, body.as_str()), (want_status, want_body), "{name}");
    }
    // `liked_at` is the like's time in the process time zone (`+05:30` in the Go run).
    let liked_at: chrono::DateTime<Utc> =
        sqlx::query_scalar("SELECT created_at FROM likes").fetch_one(pool).await.unwrap();
    let liked_at = gojson::format_rfc3339_local(&liked_at);
    let likes = |has_liked: bool| {
        format!(
            r#"{{"success":true,"data":[{{"id":881000002,"username":"bob","profile_pic":"http://p/b.jpg","profile_pic_thumb":"http://p/b_t.jpg","is_verified":true,"liked_at":"{liked_at}"}}],"count":1,"user_has_liked":{has_liked}}}"#
        )
    };
    let (likes_false, likes_true) = (likes(false), likes(true));
    let cases: Vec<(&str, (u16, String), u16, &str)> = vec![
        ("likes", a("POST", "/api/get-likes", like("alice", "2026-03-09")).await, 200, likes_false.as_str()),
        ("likes_cached", b("POST", "/api/get-likes", like("alice", "2026-03-09")).await, 200, likes_true.as_str()),
        (
            "likes_private",
            b("POST", "/api/get-likes", like("carol", "2026-03-09")).await,
            403,
            r#"{"success":false,"error":"Cannot view likes for a private account","error_code":"ACCOUNT_PRIVATE"}"#,
        ),
        (
            "unlike_private",
            b("POST", "/api/unlike-day", like("carol", "2026-03-09")).await,
            200,
            r#"{"success":true,"liked":false,"new_count":0}"#,
        ),
        (
            "unlike",
            b("POST", "/api/unlike-day", like("alice", "2026-03-09")).await,
            200,
            r#"{"success":true,"liked":false,"new_count":0}"#,
        ),
        (
            "likes_empty",
            b("POST", "/api/get-likes", like("alice", "2026-03-09")).await,
            200,
            r#"{"success":true,"data":[],"count":0,"user_has_liked":false}"#,
        ),
    ];
    for (name, (status, body), want_status, want_body) in cases {
        assert_eq!((status, body.as_str()), (want_status, want_body), "{name}");
    }
    let notifs = common::notifications(pool, alice.id, NOTIF_TYPE_LIKE_RECEIVED).await;
    assert_eq!(notifs.len(), 1);
    assert_eq!(notifs[0].title, "New Like!");
    assert_eq!(notifs[0].body, "bob liked your 9 Mar, 2026 activities");
    assert_eq!(
        notifs[0].metadata,
        Some(
            json!({"liked_date": "2026-03-09", "liker_avatar": "http://p/b.jpg", "liker_id": 881000002, "liker_username": "bob"})
        )
    );
    let _ = carol;
    db.finish().await;
}

// ==================== Activities ====================

#[tokio::test]
async fn create_activity_flows() {
    let Some(db) = TestDb::new("http_create_activity").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let app = stack.router();
    let user = create_user(&stack, "user", false).await;
    let fan = create_user(&stack, "fan", false).await;
    common::follow(&stack, &fan, &user).await;
    let body = |activity: &str, hours: f32, date: &str| {
        encode(json!({"username": "user", "activity": activity, "hours": hours, "date": date}))
    };
    let ok = (200, OK_ACTIVITY.to_string());

    // 500 multi-byte characters are accepted.
    let note = "é".repeat(500);
    let with_note =
        encode(json!({"username": "user", "activity": "study", "hours": 1, "date": "2026-03-09", "note": note}));
    assert_eq!(send(&app, &stack, &user, "POST", "/api/create-activity", Some(&with_note)).await, ok);
    let stored: Option<String> = sqlx::query_scalar("SELECT note FROM activities").fetch_one(pool).await.unwrap();
    assert_eq!(stored, Some(note));
    assert_eq!(common::count(pool, "SELECT count(*) FROM streaks").await, 0, "past days do not touch the streak");

    // Logging the same activity again replaces its hours (and the note).
    assert_eq!(
        send(&app, &stack, &user, "POST", "/api/create-activity", Some(&body("study", 4.0, "2026-03-09"))).await,
        ok
    );
    let (hours, note): (f32, Option<String>) =
        sqlx::query_as("SELECT duration_hours::float4, note FROM activities").fetch_one(pool).await.unwrap();
    assert_eq!((hours, note), (4.0, None));

    // A custom tile activity.
    let custom = "custom:9b2d6c2e-1f3b-4c5d-9e7f-0a1b2c3d4e5f";
    assert_eq!(
        send(&app, &stack, &user, "POST", "/api/create-activity", Some(&body(custom, 1.0, "2026-03-10"))).await,
        ok
    );

    // Today starts a streak ("today" is the UTC date: Go compared in the parsed date's zone).
    let today = Utc::now().date_naive().format("%Y-%m-%d").to_string();
    assert_eq!(send(&app, &stack, &user, "POST", "/api/create-activity", Some(&body("study", 1.0, &today))).await, ok);
    let streak = stack.users.streak_service.get_latest_streak(user.id).await.unwrap().unwrap();
    assert_eq!((streak.current, streak.longest, streak.activity_date.format("%Y-%m-%d").to_string()), (1, 1, today));

    // Completing a day notifies the followers in the background.
    assert_eq!(
        send(&app, &stack, &user, "POST", "/api/create-activity", Some(&body("sleep", 24.0, "2026-03-11"))).await,
        ok
    );
    let notifs = common::wait_notifications(pool, fan.id, NOTIF_TYPE_STREAK_MILESTONE, 1).await;
    assert_eq!(notifs.len(), 1);
    assert_eq!(notifs[0].body, "user logged all 24 hours on 11 Mar, 2026");

    // Database failure.
    let broken = broken(&stack).await;
    let failing = router_with(&stack, None, None, Some(&broken.activity));
    assert_eq!(
        send(&failing, &stack, &user, "POST", "/api/create-activity", Some(&body("study", 1.0, "2026-03-09"))).await,
        (400, error_body("Failed to update activity", "UPDATE_FAILED"))
    );
    db.finish().await;
}

#[tokio::test]
async fn get_activities_and_daily_totals() {
    let Some(db) = TestDb::new("http_get_activities").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let app = stack.router();
    let owner = create_user(&stack, "owner", false).await;
    let viewer = create_user(&stack, "viewer", false).await;
    let hidden = create_user(&stack, "hidden", true).await;
    insert_activity(pool, owner.id, "reels", 1.0, day(2026, 3, 5)).await;
    insert_activity(pool, owner.id, "reels", 1.0, day(2026, 6, 5)).await;
    insert_activity(pool, hidden.id, "study", 1.0, day(2026, 3, 2)).await;
    let range =
        |user: &str, start: &str, end: &str| encode(json!({"username": user, "start_date": start, "end_date": end}));

    for path in ["/api/get-activities", "/api/get-daily-totals"] {
        let cases = [
            (r#"{"username":"#.to_string(), error_body("Invalid request body", "INVALID_REQUEST")),
            (
                range("owner", "2026-3-1", "2026-03-07"),
                error_body("Invalid start_date format, use YYYY-MM-DD", "INVALID_DATE"),
            ),
            (
                range("owner", "2026-03-01", "tomorrow"),
                error_body("Invalid end_date format, use YYYY-MM-DD", "INVALID_DATE"),
            ),
            (
                range("owner", "2026-03-08", "2026-03-07"),
                error_body("Start date must be before end date", "INVALID_DATE_RANGE"),
            ),
            (range("nobody", "2026-03-01", "2026-03-07"), error_body("Failed to find user", "USER_NOT_FOUND")),
        ];
        for (body, want) in cases {
            assert_eq!(send(&app, &stack, &viewer, "POST", path, Some(&body)).await, (400, want), "{path} {body}");
        }
        let res = send(&app, &stack, &viewer, "POST", path, Some(&range("hidden", "2026-03-01", "2026-03-07"))).await;
        assert_eq!(res, (403, error_body("This account is private", "ACCOUNT_PRIVATE")));
    }

    // Exactly 93 days.
    let res =
        send(&app, &stack, &viewer, "POST", "/api/get-daily-totals", Some(&range("owner", "2026-03-05", "2026-06-06")))
            .await;
    assert_eq!(res, (200, r#"{"success":true,"data":{"2026-03-05":1,"2026-06-05":1}}"#.to_string()));

    // Followers see private activities.
    common::follow(&stack, &viewer, &hidden).await;
    let res =
        send(&app, &stack, &viewer, "POST", "/api/get-activities", Some(&range("hidden", "2026-03-01", "2026-03-07")))
            .await;
    assert_eq!(
        res,
        (200, r#"{"success":true,"data":[{"id":3,"name":"study","hours":1,"date":"2026-03-02"}]}"#.to_string())
    );

    // Database failures.
    let broken = broken(&stack).await;
    let failing = router_with(&stack, None, None, Some(&broken.activity));
    let res = send(
        &failing,
        &stack,
        &owner,
        "POST",
        "/api/get-activities",
        Some(&range("owner", "2026-03-01", "2026-03-07")),
    )
    .await;
    assert_eq!(res, (400, error_body("Failed to find activities", "FETCH_FAILED")));
    let res = send(
        &failing,
        &stack,
        &owner,
        "POST",
        "/api/get-daily-totals",
        Some(&range("owner", "2026-03-01", "2026-03-07")),
    )
    .await;
    assert_eq!(res, (400, error_body("Failed to fetch daily totals", "FETCH_FAILED")));
    let lookup_fails = router_with(&stack, Some(&broken.users), None, None);
    let res = send(
        &lookup_fails,
        &stack,
        &owner,
        "POST",
        "/api/get-activities",
        Some(&range("owner", "2026-03-01", "2026-03-07")),
    )
    .await;
    assert_eq!(res, (400, error_body("Failed to find user", "USER_NOT_FOUND")));
    db.finish().await;
}

// ==================== Streaks and analytics ====================

#[tokio::test]
async fn get_streak() {
    let Some(db) = TestDb::new("http_get_streak").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let app = stack.router();
    let owner = create_user(&stack, "owner", false).await;
    let viewer = create_user(&stack, "viewer", false).await;
    let hidden = create_user(&stack, "hidden", true).await;
    let fan = create_user(&stack, "fan", false).await;
    common::follow(&stack, &fan, &hidden).await;
    insert_streak(pool, owner.id, 1, 1, day(2026, 3, 9)).await;
    insert_streak(pool, hidden.id, 1, 1, day(2026, 3, 9)).await;
    let body = |user: &str, date: &str| encode(json!({"username": user, "date": date}));

    let cases = [
        (r#"{"username":"#.to_string(), 400, error_body("Invalid request body", "INVALID_REQUEST")),
        (body("owner", "March 9"), 400, error_body("Invalid date format, use YYYY-MM-DD", "INVALID_DATE")),
        (body("nobody", "2026-03-09"), 400, error_body("Failed to find user", "USER_NOT_FOUND")),
        (body("hidden", "2026-03-09"), 403, error_body("This account is private", "ACCOUNT_PRIVATE")),
        (body("owner", "2026-03-10"), 400, error_body("Failed to find streak", "STREAK_NOT_FOUND")),
    ];
    for (req, status, want) in cases {
        assert_eq!(send(&app, &stack, &viewer, "POST", "/api/get-streak", Some(&req)).await, (status, want), "{req}");
    }
    let res = send(&app, &stack, &fan, "POST", "/api/get-streak", Some(&body("hidden", "2026-03-09"))).await;
    assert_eq!(
        res,
        (200, r#"{"success":true,"data":{"id":2,"current":1,"longest":1,"date":"2026-03-09"}}"#.to_string())
    );

    // Badge problems do not fail the request.
    let broken = broken(&stack).await;
    let mut users = stack.users.clone();
    users.badge_service = broken.users.badge_service.clone();
    let no_badges = router_with(&stack, Some(&users), None, None);
    let res = send(&no_badges, &stack, &owner, "POST", "/api/get-streak", Some(&body("owner", "2026-03-09"))).await;
    assert_eq!(
        res,
        (200, r#"{"success":true,"data":{"id":1,"current":1,"longest":1,"date":"2026-03-09"}}"#.to_string())
    );
    assert_eq!(common::count(pool, "SELECT count(*) FROM user_badges").await, 0);

    // Database failures.
    let lookup_fails = router_with(&stack, Some(&broken.users), None, None);
    let res = send(&lookup_fails, &stack, &owner, "POST", "/api/get-streak", Some(&body("owner", "2026-03-09"))).await;
    assert_eq!(res, (400, error_body("Failed to find user", "USER_NOT_FOUND")));
    let mut users = stack.users.clone();
    users.streak_service = broken.users.streak_service.clone();
    let streak_fails = router_with(&stack, Some(&users), None, None);
    let res = send(&streak_fails, &stack, &owner, "POST", "/api/get-streak", Some(&body("owner", "2026-03-09"))).await;
    assert_eq!(res, (400, error_body("Failed to find streak", "STREAK_NOT_FOUND")));
    db.finish().await;
}

#[tokio::test]
async fn get_week_analytics() {
    let Some(db) = TestDb::new("http_week_analytics").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let app = stack.router();
    let owner = create_user(&stack, "owner", false).await;
    let viewer = create_user(&stack, "viewer", false).await;
    let hidden = create_user(&stack, "hidden", true).await;
    let monday = day(2026, 3, 9);
    insert_activity(pool, owner.id, "study", 4.0, monday).await;
    insert_activity(pool, owner.id, "sleep", 8.0, monday).await;
    insert_activity(pool, owner.id, "study", 2.0, day(2026, 3, 11)).await;
    insert_activity(pool, owner.id, "workout", 7.0, day(2026, 3, 6)).await;
    insert_streak(pool, owner.id, 1, 1, day(2026, 3, 10)).await;
    insert_streak(pool, owner.id, 2, 2, day(2026, 3, 11)).await;
    let body = |user: &str| encode(json!({"username": user, "week_start": "2026-03-09"}));

    let res = send(&app, &stack, &viewer, "POST", "/api/get-week-analytics", Some(&body("hidden"))).await;
    assert_eq!(res, (403, error_body("This account is private", "ACCOUNT_PRIVATE")));
    let res = send(&app, &stack, &viewer, "POST", "/api/get-week-analytics", Some(&body("nobody"))).await;
    assert_eq!(res, (400, error_body("Failed to find user", "USER_NOT_FOUND")));

    let (status, text) = send(&app, &stack, &viewer, "POST", "/api/get-week-analytics", Some(&body("owner"))).await;
    assert_eq!(status, 200);
    let got: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(got["total_hours_this_week"], json!(14));
    assert_eq!(got["total_hours_prev_week"], json!(7));
    assert_eq!(got["percentage_change"], json!(100));
    assert_eq!(
        got["activity_summary"],
        json!([{"name": "sleep", "total_hours": 8}, {"name": "study", "total_hours": 6}])
    );
    assert_eq!(
        got["daily_breakdown"][0],
        json!({"date": "2026-03-09", "day_name": "Mon", "total_hours": 12, "activities": [{"name": "sleep", "hours": 8}, {"name": "study", "hours": 4}]})
    );
    assert_eq!(
        got["daily_breakdown"][6],
        json!({"date": "2026-03-15", "day_name": "Sun", "total_hours": 0, "activities": []})
    );
    assert_eq!(
        got["streak"],
        json!({"current": 2, "longest": 2, "longest_start": "2026-03-10", "longest_end": "2026-03-11"})
    );

    common::follow(&stack, &viewer, &hidden).await;
    let (status, text) = send(&app, &stack, &viewer, "POST", "/api/get-week-analytics", Some(&body("hidden"))).await;
    assert_eq!(status, 200, "followers see a private user's analytics");
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap()["daily_breakdown"].as_array().unwrap().len(), 7);

    let broken = broken(&stack).await;
    let failing = router_with(&stack, None, None, Some(&broken.activity));
    let res = send(&failing, &stack, &owner, "POST", "/api/get-week-analytics", Some(&body("owner"))).await;
    assert_eq!(res, (500, error_body("Failed to fetch analytics", "FETCH_FAILED")));
    let lookup_fails = router_with(&stack, Some(&broken.users), None, None);
    let res = send(&lookup_fails, &stack, &owner, "POST", "/api/get-week-analytics", Some(&body("owner"))).await;
    assert_eq!(res, (400, error_body("Failed to find user", "USER_NOT_FOUND")));
    db.finish().await;
}

// ==================== Badges ====================

#[tokio::test]
async fn badges() {
    let Some(db) = TestDb::new("http_badges").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let app = stack.router();
    let user = create_user(&stack, "user", false).await;
    let hidden = create_user(&stack, "hidden", true).await;
    let earned_at: chrono::DateTime<Utc> = "2026-03-09T00:00:00Z".parse().unwrap();
    for (user_id, key) in [(user.id, "first_step"), (hidden.id, "spark_starter")] {
        sqlx::query("INSERT INTO user_badges (user_id, badge_key, earned_at) VALUES ($1, $2, $3)")
            .bind(user_id)
            .bind(key)
            .bind(earned_at)
            .execute(pool)
            .await
            .unwrap();
    }
    // The earned date is taken in the process time zone.
    let earned_on = gojson::to_go_local(&earned_at).date_naive().format("%Y-%m-%d").to_string();
    let earned = |text: &str| -> Vec<String> {
        let got: Value = serde_json::from_str(text).unwrap();
        let badges = got["badges"].as_array().unwrap();
        assert_eq!(badges.len(), 7);
        badges.iter().filter(|b| b["earned"] == json!(true)).map(|b| b["key"].as_str().unwrap().to_string()).collect()
    };

    let (status, text) = send(&app, &stack, &user, "GET", "/api/badges", None).await;
    assert_eq!(status, 200);
    assert_eq!(earned(&text), vec!["first_step"]);
    assert!(text.starts_with(&format!(
        r##"{{"success":true,"badges":[{{"key":"first_step","name":"First Step","icon":"Footprints","color":"#22c55e","threshold":1,"earned":true,"earned_at":"{earned_on}"}},{{"key":"spark_starter","name":"Spark Starter","icon":"Zap","color":"#3b82f6","threshold":7,"earned":false}},"##
    )));

    let res = send(&app, &stack, &user, "POST", "/api/badges/user", Some(r#"{"username":"#)).await;
    assert_eq!(res, (400, error_body("Invalid request body", "INVALID_REQUEST")));
    let (status, text) = send(&app, &stack, &user, "POST", "/api/badges/user", Some(r#"{"username":"hidden"}"#)).await;
    assert_eq!(status, 200, "badges are public even for private accounts");
    assert_eq!(earned(&text), vec!["spark_starter"]);

    let broken = broken(&stack).await;
    let failing = router_with(&stack, Some(&broken.users), None, None);
    assert_eq!(
        send(&failing, &stack, &ghost(), "GET", "/api/badges", None).await,
        (500, error_body("Failed to get badges", "SERVER_ERROR"))
    );
    assert_eq!(
        send(&failing, &stack, &ghost(), "POST", "/api/badges/user", Some(r#"{"username":"user"}"#)).await,
        (400, error_body("Failed to find user", "USER_NOT_FOUND"))
    );
    let mut users = stack.users.clone();
    users.badge_service = broken.users.badge_service.clone();
    let badge_query_fails = router_with(&stack, Some(&users), None, None);
    assert_eq!(
        send(&badge_query_fails, &stack, &ghost(), "POST", "/api/badges/user", Some(r#"{"username":"user"}"#)).await,
        (500, error_body("Failed to get badges", "SERVER_ERROR"))
    );
    db.finish().await;
}

// ==================== Tile configuration ====================

fn custom_tile(id: &str, name: &str) -> Value {
    json!({"id": id, "name": name, "icon": "Guitar", "color": "#123abc"})
}

#[tokio::test]
async fn tile_config_validation_and_relabeling() {
    let Some(db) = TestDb::new("http_tile_config").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let app = stack.router();
    let user = create_user(&stack, "user", false).await;
    let id = "3f0d6c2e-1f3b-4c5d-9e7f-0a1b2c3d4e5f";
    let save = |config: Value| encode(json!({"config": config}));
    let six: Vec<Value> =
        (0..6).map(|i| custom_tile(&format!("00000000-0000-4000-8000-00000000000{i}"), "Tile")).collect();
    let bad_tile = |key: &str, value: Value| {
        let mut tile = custom_tile(id, "Tile");
        tile[key] = value;
        save(json!({"customTiles": [tile]}))
    };

    let cases = [
        (r#"{"config":"#.to_string(), error_body("Invalid request body", "INVALID_REQUEST")),
        (r#"{"config":[1,2]}"#.to_string(), error_body("Invalid request body", "INVALID_REQUEST")),
        (save(json!({"order": "study"})), error_body("Invalid configuration format", "INVALID_TILE_CONFIG")),
        (save(json!({"customTiles": six})), error_body("Maximum of 5 custom tiles allowed", "TILE_LIMIT_EXCEEDED")),
        (bad_tile("id", json!("")), error_body("custom tile ID is required", "INVALID_TILE_CONFIG")),
        (bad_tile("id", json!("tile-1")), error_body("custom tile ID must be a valid UUID", "INVALID_TILE_CONFIG")),
        (
            bad_tile("name", json!("n".repeat(21))),
            error_body("custom tile name cannot exceed 20 characters", "INVALID_TILE_CONFIG"),
        ),
        (
            bad_tile("color", json!("blue")),
            error_body("custom tile color must be a valid hex color", "INVALID_TILE_CONFIG"),
        ),
        (
            save(json!({"customTiles": [custom_tile(id, "A"), custom_tile(id, "B")]})),
            error_body("Duplicate custom tile ID found", "INVALID_TILE_CONFIG"),
        ),
        (save(json!({"colors": {"study": "red"}})), error_body("Invalid color format: red", "INVALID_COLOR")),
    ];
    for (body, want) in cases {
        assert_eq!(send(&app, &stack, &user, "POST", "/api/tile-config", Some(&body)).await, (400, want), "{body}");
    }
    assert_eq!(common::count(pool, "SELECT count(*) FROM tile_configs").await, 0, "nothing was stored");

    let photo = insert_photo(pool, user.id, &format!("custom:{id}"), day(2026, 3, 9), Some("Guitar")).await;
    let config = json!({
        "order": ["study", "sleep"], "sizes": {"study": "large"}, "hidden": ["reels"], "colors": {"study": "#ff0000"},
        "customTiles": [custom_tile(id, "Guitar")]
    });
    assert_eq!(
        send(&app, &stack, &user, "POST", "/api/tile-config", Some(&save(config.clone()))).await,
        (200, OK_TILES.to_string())
    );
    let (status, text) = send(&app, &stack, &user, "GET", "/api/tile-config", None).await;
    assert_eq!(
        (status, serde_json::from_str::<Value>(&text).unwrap()),
        (200, json!({"success": true, "data": config}))
    );
    assert_eq!(photo_label(pool, photo).await.as_deref(), Some("Guitar"), "unchanged names leave photos alone");

    let renamed = save(json!({"customTiles": [custom_tile(id, "Piano")]}));
    assert_eq!(
        send(&app, &stack, &user, "POST", "/api/tile-config", Some(&renamed)).await,
        (200, OK_TILES.to_string())
    );
    assert_eq!(photo_label(pool, photo).await.as_deref(), Some("Piano"), "renaming a custom tile relabels its photos");

    let replacement = json!({"order": ["sleep"]});
    assert_eq!(
        send(&app, &stack, &user, "POST", "/api/tile-config", Some(&save(replacement.clone()))).await,
        (200, OK_TILES.to_string())
    );
    let (_, text) = send(&app, &stack, &user, "GET", "/api/tile-config", None).await;
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({"success": true, "data": replacement}));
    assert_eq!(common::count(pool, "SELECT count(*) FROM tile_configs").await, 1);

    // Relabeling photos fails: nothing is saved.
    let original = json!({"customTiles": [custom_tile(id, "Guitar")]});
    assert_eq!(
        send(&app, &stack, &user, "POST", "/api/tile-config", Some(&save(original.clone()))).await,
        (200, OK_TILES.to_string())
    );
    common::fail_on(pool, "UPDATE", "activity_photos").await;
    let res = send(
        &app,
        &stack,
        &user,
        "POST",
        "/api/tile-config",
        Some(&save(json!({"customTiles": [custom_tile(id, "Piano")]}))),
    )
    .await;
    assert_eq!(res, (500, error_body("Failed to save tile configuration", "SAVE_FAILED")));
    common::stop_failing(pool, "UPDATE", "activity_photos").await;
    let (_, text) = send(&app, &stack, &user, "GET", "/api/tile-config", None).await;
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({"success": true, "data": original}));

    // Unknown caller and database failures.
    let res = send(&app, &stack, &ghost(), "POST", "/api/tile-config", Some(&save(json!({"order": ["study"]})))).await;
    assert_eq!(res, (500, error_body("Failed to save tile configuration", "SAVE_FAILED")));
    let broken = broken(&stack).await;
    let failing = router_with(&stack, None, None, Some(&broken.activity));
    let res = send(&failing, &stack, &user, "POST", "/api/tile-config", Some(&save(json!({"order": ["study"]})))).await;
    assert_eq!(res, (500, error_body("Failed to save tile configuration", "SAVE_FAILED")));
    let res = send(&failing, &stack, &ghost(), "GET", "/api/tile-config", None).await;
    assert_eq!(res, (500, error_body("Failed to get tile configuration", "FETCH_FAILED")));
    db.finish().await;
}

#[tokio::test]
async fn tile_config_by_username() {
    let Some(db) = TestDb::new("http_tile_config_user").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let app = stack.router();
    let viewer = create_user(&stack, "viewer", false).await;
    let owner = create_user(&stack, "owner", false).await;
    let hidden = create_user(&stack, "hidden", true).await;
    let fan = create_user(&stack, "fan", false).await;
    common::follow(&stack, &fan, &hidden).await;
    for user_id in [owner.id, hidden.id] {
        sqlx::query(r#"INSERT INTO tile_configs (user_id, config) VALUES ($1, '{"order":["study"]}')"#)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap();
    }
    let path = "/api/tile-config/user";
    let cases = [
        (r#"{"username":"#, 400, error_body("Invalid request body", "INVALID_REQUEST")),
        (r#"{"username":""}"#, 400, error_body("Username is required", "MISSING_FIELDS")),
        (r#"{"username":"nobody"}"#, 404, error_body("User not found", "USER_NOT_FOUND")),
        (r#"{"username":"hidden"}"#, 403, error_body("This account is private", "ACCOUNT_PRIVATE")),
    ];
    for (body, status, want) in cases {
        assert_eq!(send(&app, &stack, &viewer, "POST", path, Some(body)).await, (status, want), "{body}");
    }
    let with_config = r#"{"success":true,"data":{"order":["study"]}}"#.to_string();
    assert_eq!(
        send(&app, &stack, &viewer, "POST", path, Some(r#"{"username":"owner"}"#)).await,
        (200, with_config.clone())
    );
    assert_eq!(send(&app, &stack, &fan, "POST", path, Some(r#"{"username":"hidden"}"#)).await, (200, with_config));
    assert_eq!(
        send(&app, &stack, &owner, "POST", path, Some(r#"{"username":"viewer"}"#)).await,
        (200, r#"{"success":true,"data":null}"#.to_string())
    );

    let broken = broken(&stack).await;
    let lookup_fails = router_with(&stack, Some(&broken.users), None, None);
    assert_eq!(
        send(&lookup_fails, &stack, &owner, "POST", path, Some(r#"{"username":"owner"}"#)).await,
        (404, error_body("User not found", "USER_NOT_FOUND"))
    );
    let config_fails = router_with(&stack, None, None, Some(&broken.activity));
    assert_eq!(
        send(&config_fails, &stack, &owner, "POST", path, Some(r#"{"username":"owner"}"#)).await,
        (500, error_body("Failed to get tile configuration", "FETCH_FAILED"))
    );
    db.finish().await;
}

// ==================== Likes ====================

const LIKE_PATHS: [&str; 3] = ["/api/like-day", "/api/unlike-day", "/api/get-likes"];

fn like_body(username: &str, date: &str) -> String {
    encode(json!({"username": username, "date": date}))
}

#[tokio::test]
async fn like_validation_and_lookup_failures() {
    let Some(db) = TestDb::new("http_like_validation").await else { return };
    let stack = Stack::new(&db.pool);
    let app = stack.router();
    let user = create_user(&stack, "user", false).await;
    let broken = broken(&stack).await;
    let lookup_fails = router_with(&stack, Some(&broken.users), None, None);
    let cases = [
        (r#"{"username":"#.to_string(), error_body("Invalid request body", "INVALID_REQUEST")),
        (like_body("", "2026-03-09"), error_body("Username and date are required", "MISSING_FIELDS")),
        (like_body("user", ""), error_body("Username and date are required", "MISSING_FIELDS")),
        (like_body("user", "2026-13-01"), error_body("Invalid date format, use YYYY-MM-DD", "INVALID_DATE")),
        (like_body("nobody", "2026-03-09"), error_body("User not found", "USER_NOT_FOUND")),
    ];
    for path in LIKE_PATHS {
        for (body, want) in &cases {
            assert_eq!(send(&app, &stack, &user, "POST", path, Some(body)).await, (400, want.clone()), "{path} {body}");
        }
        assert_eq!(
            send(&lookup_fails, &stack, &ghost(), "POST", path, Some(&like_body("someone", "2026-03-09"))).await,
            (400, error_body("Failed to find user", "DATABASE_ERROR")),
            "{path}"
        );
    }
    db.finish().await;
}

#[tokio::test]
async fn like_and_unlike_day() {
    let Some(db) = TestDb::new("http_like_flow").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let app = stack.router();
    let owner = create_user(&stack, "owner", false).await;
    let liker = create_user(&stack, "liker", false).await;
    stack.users.user_repo.update_profile_pic(liker.id, Some("http://pics.example/liker.jpg"), None).await.unwrap();
    let other = create_user(&stack, "other", false).await;
    let body = like_body("owner", "2026-03-09");
    let action = |liked: bool, count: i64| (200, format!(r#"{{"success":true,"liked":{liked},"new_count":{count}}}"#));
    let like_notifications = || async { common::notifications(pool, owner.id, NOTIF_TYPE_LIKE_RECEIVED).await };

    assert_eq!(send(&app, &stack, &liker, "POST", "/api/like-day", Some(&body)).await, action(true, 1));
    let notifs = like_notifications().await;
    assert_eq!(notifs.len(), 1, "like notifies the owner");
    assert_eq!(notifs[0].body, "liker liked your 9 Mar, 2026 activities");
    assert_eq!(notifs[0].metadata.as_ref().unwrap()["liker_avatar"], "http://pics.example/liker.jpg");

    assert_eq!(send(&app, &stack, &liker, "POST", "/api/like-day", Some(&body)).await, action(true, 1), "idempotent");
    assert_eq!(common::count(pool, "SELECT count(*) FROM likes").await, 1);
    assert_eq!(send(&app, &stack, &other, "POST", "/api/like-day", Some(&body)).await, action(true, 2));
    assert_eq!(like_notifications().await.len(), 2);
    assert_eq!(send(&app, &stack, &liker, "POST", "/api/unlike-day", Some(&body)).await, action(false, 1));
    assert_eq!(
        send(&app, &stack, &liker, "POST", "/api/unlike-day", Some(&body)).await,
        action(false, 1),
        "nothing to unlike"
    );
    assert_eq!(send(&app, &stack, &liker, "POST", "/api/like-day", Some(&body)).await, action(true, 2));
    assert_eq!(like_notifications().await.len(), 2, "re-liking does not notify twice");
    assert_eq!(send(&app, &stack, &owner, "POST", "/api/like-day", Some(&body)).await, action(true, 3));
    assert_eq!(like_notifications().await.len(), 2, "liking your own day sends no notification");

    // Notification problems do not fail the like.
    sqlx::query("DELETE FROM likes").execute(pool).await.unwrap();
    let broken = broken(&stack).await;
    let no_notifications = router_with(&stack, None, Some(&broken.notify), None);
    let fresh = create_user(&stack, "fresh", false).await;
    assert_eq!(send(&no_notifications, &stack, &fresh, "POST", "/api/like-day", Some(&body)).await, action(true, 1));
    assert_eq!(like_notifications().await.len(), 2);
    db.finish().await;
}

#[tokio::test]
async fn likes_of_private_accounts() {
    let Some(db) = TestDb::new("http_like_private").await else { return };
    let stack = Stack::new(&db.pool);
    let app = stack.router();
    let hidden = create_user(&stack, "hidden", true).await;
    let stranger = create_user(&stack, "stranger", false).await;
    let fan = create_user(&stack, "fan", false).await;
    common::follow(&stack, &fan, &hidden).await;
    let body = like_body("hidden", "2026-03-09");

    assert_eq!(
        send(&app, &stack, &stranger, "POST", "/api/like-day", Some(&body)).await,
        (403, error_body("Cannot like a private account's day", "ACCOUNT_PRIVATE"))
    );
    assert_eq!(
        send(&app, &stack, &stranger, "POST", "/api/get-likes", Some(&body)).await,
        (403, error_body("Cannot view likes for a private account", "ACCOUNT_PRIVATE"))
    );
    assert_eq!(
        send(&app, &stack, &fan, "POST", "/api/like-day", Some(&body)).await,
        (200, r#"{"success":true,"liked":true,"new_count":1}"#.to_string())
    );
    let (status, text) = send(&app, &stack, &fan, "POST", "/api/get-likes", Some(&body)).await;
    assert_eq!(status, 200);
    let got: Value = serde_json::from_str(&text).unwrap();
    assert_eq!((got["count"].clone(), got["user_has_liked"].clone()), (json!(1), json!(true)));
    db.finish().await;
}

#[tokio::test]
async fn get_likes_lists_newest_first() {
    let Some(db) = TestDb::new("http_like_list").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let app = stack.router();
    let owner = create_user(&stack, "owner", false).await;
    let early = create_user(&stack, "early", false).await;
    let late = create_user(&stack, "late", false).await;
    let viewer = create_user(&stack, "viewer", false).await;
    sqlx::query("UPDATE users SET profile_pic = 'http://pics.example/early.jpg', is_verified = true WHERE id = $1")
        .bind(early.id)
        .execute(pool)
        .await
        .unwrap();
    for (liker, date, at) in [
        (early.id, "2026-03-09", "2026-03-09T10:00:00Z"),
        (late.id, "2026-03-09", "2026-03-09T11:00:00Z"),
        (viewer.id, "2026-03-10", "2026-03-09T10:00:00Z"),
    ] {
        sqlx::query("INSERT INTO likes (liker_id, liked_user_id, liked_date, created_at) VALUES ($1, $2, $3::date, $4::timestamptz)")
            .bind(liker)
            .bind(owner.id)
            .bind(date)
            .bind(at)
            .execute(pool)
            .await
            .unwrap();
    }

    let res = send(&app, &stack, &viewer, "POST", "/api/get-likes", Some(&like_body("owner", "2026-03-09"))).await;
    // `liked_at` is RFC 3339 in the process time zone (`2026-03-09T16:30:00+05:30` on an IST host).
    let local = |at: &str| gojson::format_rfc3339_local(&at.parse().unwrap());
    let want = format!(
        r#"{{"success":true,"data":[{{"id":{},"username":"late","is_verified":false,"liked_at":"{}"}},{{"id":{},"username":"early","profile_pic":"http://pics.example/early.jpg","is_verified":true,"liked_at":"{}"}}],"count":2,"user_has_liked":false}}"#,
        late.id,
        local("2026-03-09T11:00:00Z"),
        early.id,
        local("2026-03-09T10:00:00Z")
    );
    assert_eq!(res, (200, want));
    let (_, text) = send(&app, &stack, &early, "POST", "/api/get-likes", Some(&like_body("owner", "2026-03-09"))).await;
    assert!(text.ends_with(r#""count":2,"user_has_liked":true}"#));
    assert_eq!(
        send(&app, &stack, &viewer, "POST", "/api/get-likes", Some(&like_body("owner", "2026-03-11"))).await,
        (200, r#"{"success":true,"data":[],"count":0,"user_has_liked":false}"#.to_string())
    );
    db.finish().await;
}

#[tokio::test]
async fn like_database_failures() {
    let Some(db) = TestDb::new("http_like_failures").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let owner = create_user(&stack, "owner", false).await;
    let fan = create_user(&stack, "fan", false).await;
    let body = like_body("owner", "2026-03-09");
    let broken = broken(&stack).await;
    let likes_fail = router_with(&stack, None, None, Some(&broken.activity));

    assert_eq!(
        send(&likes_fail, &stack, &fan, "POST", "/api/like-day", Some(&body)).await,
        (500, error_body("Failed to process like", "DATABASE_ERROR"))
    );
    assert_eq!(
        send(&likes_fail, &stack, &fan, "POST", "/api/get-likes", Some(&body)).await,
        (500, error_body("Failed to get likes", "FETCH_FAILED"))
    );
    assert_eq!(
        send(&likes_fail, &stack, &fan, "POST", "/api/unlike-day", Some(&body)).await,
        (500, error_body("Failed to unlike day", "DELETE_FAILED"))
    );

    common::fail_on(pool, "INSERT", "likes").await;
    assert_eq!(
        send(&stack.router(), &stack, &fan, "POST", "/api/like-day", Some(&body)).await,
        (500, error_body("Failed to like day", "CREATE_FAILED"))
    );
    assert!(common::notifications(pool, owner.id, NOTIF_TYPE_LIKE_RECEIVED).await.is_empty());
    db.finish().await;
}

/// Fiber answers other methods on these paths without running the route middleware; the
/// server's 405 fallback handles them, so the guard must not reject them first.
#[tokio::test]
async fn other_methods_skip_the_guard() {
    let Some(db) = TestDb::new("http_methods").await else { return };
    let stack = Stack::new(&db.pool);
    let request = axum::http::Request::builder()
        .method("GET")
        .uri("/api/create-activity")
        .body(axum::body::Body::empty())
        .unwrap();
    let response = tower::ServiceExt::oneshot(stack.router(), request).await.unwrap();
    assert_eq!(response.status(), 405);
    db.finish().await;
}
