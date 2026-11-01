//! Privacy, bio, profiles, user search and autocomplete (port of `profile_test.go`).

mod common;

use std::collections::BTreeMap;

use common::{eventually, redis_del, redis_get, redis_ready, redis_set, request, run, send, Env, TestUser, UserOpts};
use serde_json::{json, Value};

/// A lowercase tag unique to this run, so shared-Redis autocomplete cache keys never collide.
fn unique_tag() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos();
    format!("q{:x}{:x}", std::process::id() % 4096, nanos % 0xfffff)
}

async fn add_streak(env: &Env, user_id: i64, current: i64, longest: i64, date: &str) {
    sqlx::query("INSERT INTO streaks (user_id, current, longest, activity_date) VALUES ($1, $2, $3, $4::date)")
        .bind(user_id)
        .bind(current)
        .bind(longest)
        .bind(date)
        .execute(env.pool())
        .await
        .unwrap();
}

#[test]
fn privacy_and_bio() {
    run(async {
        let Some(env) = Env::new("profile_privacy_bio").await else { return };
        redis_ready().await;
        let user = env.plain_user().await;
        let ghost = env.token(user.id + 400, "ghost");
        let call = |method: &str, uri: &str, body: Option<&str>| env.call(method, uri, Some(&user), body);

        call("POST", "/api/update-privacy", Some(r#"{"is_private":"#)).await.assert_error(
            400,
            "INVALID_REQUEST",
            "Invalid request body",
        );
        call("POST", "/api/update-privacy", Some(r#"{"is_private":"yes"}"#)).await.assert_error(
            400,
            "INVALID_REQUEST",
            "Invalid request body",
        );
        let resp = call("POST", "/api/update-privacy", Some(r#"{"is_private":true}"#)).await;
        assert_eq!(resp.body, r#"{"is_private":true,"message":"Privacy setting updated","success":true}"#);
        assert_eq!(call("GET", "/api/get-privacy", None).await.body, r#"{"success":true,"is_private":true}"#);
        call("POST", "/api/update-privacy", Some("{}")).await;
        assert_eq!(call("GET", "/api/get-privacy", None).await.body, r#"{"success":true,"is_private":false}"#);
        send(&env.app, request("GET", "/api/get-privacy", Some(&ghost), None)).await.assert_error(
            500,
            "FETCH_FAILED",
            "Failed to get privacy setting",
        );

        call("POST", "/api/update-bio", Some(r#"{"bio":"#)).await.assert_error(
            400,
            "INVALID_REQUEST",
            "Invalid request body",
        );
        let too_long = json!({ "bio": "a".repeat(151) }).to_string();
        call("POST", "/api/update-bio", Some(&too_long)).await.assert_error(
            400,
            "BIO_TOO_LONG",
            "Bio must be 150 characters or less",
        );
        let resp = call("POST", "/api/update-bio", Some(&json!({ "bio": "  Learning <Go> 🚀\n" }).to_string())).await;
        assert_eq!(
            resp.body,
            r#"{"bio":"Learning \u003cGo\u003e 🚀","message":"Bio updated successfully","success":true}"#
        );
        assert_eq!(
            call("GET", "/api/get-bio", None).await.body,
            r#"{"success":true,"bio":"Learning \u003cGo\u003e 🚀"}"#
        );
        // Length counts characters: 150 two-byte characters fit, 151 do not.
        let accented = "é".repeat(150);
        assert_eq!(call("POST", "/api/update-bio", Some(&json!({ "bio": accented }).to_string())).await.status, 200);
        assert_eq!(call("GET", "/api/get-bio", None).await.json()["bio"], accented);
        call("POST", "/api/update-bio", Some(&json!({ "bio": format!("{accented}é") }).to_string()))
            .await
            .assert_error(400, "BIO_TOO_LONG", "Bio must be 150 characters or less");
        // A blank bio clears it.
        assert_eq!(call("POST", "/api/update-bio", Some(r#"{"bio":"   "}"#)).await.status, 200);
        assert_eq!(call("GET", "/api/get-bio", None).await.body, r#"{"success":true,"bio":null}"#);
        send(&env.app, request("GET", "/api/get-bio", Some(&ghost), None)).await.assert_error(
            500,
            "FETCH_FAILED",
            "Failed to get bio",
        );
        env.finish().await;
    });
}

#[test]
fn own_profile() {
    run(async {
        let Some(env) = Env::new("profile_own").await else { return };
        redis_ready().await;
        let me = env
            .user(UserOpts {
                bio: Some("hello".into()),
                picture: Some("http://pics.example/me.jpg".into()),
                verified: true,
                ..Default::default()
            })
            .await;
        let (fan1, fan2) = (env.plain_user().await, env.plain_user().await);
        env.follow(fan1.id, me.id, "ACTIVE").await;
        env.follow(fan2.id, me.id, "ACTIVE").await;
        env.follow(me.id, fan1.id, "ACTIVE").await;

        let resp = env.call("GET", "/api/profile", Some(&me), None).await;
        assert_eq!(
            resp.body,
            format!(
                r#"{{"success":true,"username":"{}","email":"{}","profile_pic":"http://pics.example/me.jpg","profile_pic_thumb":"http://pics.example/me.jpg?thumb","bio":"hello","is_private":false,"is_verified":true,"email_verified":true,"followers_count":2,"following_count":1}}"#,
                me.username, me.email
            )
        );
        let resp = env.call("GET", "/api/profile", Some(&fan1), None).await;
        assert!(resp.body.contains(r#""profile_pic":null,"bio":null,"#), "{}", resp.body);
        let ghost = env.token(me.id + 400, "ghost");
        send(&env.app, request("GET", "/api/profile", Some(&ghost), None)).await.assert_error(
            404,
            "USER_NOT_FOUND",
            "User not found",
        );
        env.finish().await;
    });
}

#[test]
fn other_users_profiles() {
    run(async {
        let Some(env) = Env::new("profile_others").await else { return };
        redis_ready().await;
        let bio = |s: &str| Some(s.to_string());
        let viewer = env.user(UserOpts { bio: bio("my bio"), ..Default::default() }).await;
        let public = env.user(UserOpts { bio: bio("public bio"), ..Default::default() }).await;
        let hidden = env.user(UserOpts { private: true, bio: bio("secret bio"), ..Default::default() }).await;
        let friend = env.user(UserOpts { private: true, bio: bio("friend bio"), ..Default::default() }).await;
        let pending = env.user(UserOpts { private: true, bio: bio("pending bio"), ..Default::default() }).await;
        env.follow(viewer.id, friend.id, "ACTIVE").await;
        env.follow(viewer.id, pending.id, "PENDING").await;
        add_streak(&env, public.id, 3, 5, "2026-03-09").await;
        add_streak(&env, public.id, 0, 5, "2026-03-10").await;
        add_streak(&env, hidden.id, 2, 2, "2026-03-09").await;
        add_streak(&env, friend.id, 1, 1, "2026-03-11").await;

        let profile =
            |target: &TestUser| env.call("GET", &format!("/api/users/{}/profile", target.id), Some(&viewer), None);
        let resp = profile(&public).await;
        assert_eq!(
            resp.body,
            format!(
                r#"{{"success":true,"id":{},"username":"{}","profile_pic":null,"bio":"public bio","is_private":false,"is_verified":false,"followers_count":0,"following_count":0,"relationship_state":"NONE","last_logged_at":"2026-03-09T00:00:00Z"}}"#,
                public.id, public.username
            )
        );
        let resp = profile(&hidden).await;
        assert_eq!(
            resp.body,
            format!(
                r#"{{"success":true,"id":{},"username":"{}","profile_pic":null,"is_private":true,"is_verified":false,"followers_count":0,"following_count":0,"relationship_state":"NONE"}}"#,
                hidden.id, hidden.username
            )
        );
        let v = profile(&friend).await.json();
        assert_eq!((v["relationship_state"].as_str(), v["bio"].as_str()), (Some("FOLLOWING"), Some("friend bio")));
        assert_eq!(
            (v["followers_count"].as_i64(), v["last_logged_at"].as_str()),
            (Some(1), Some("2026-03-11T00:00:00Z"))
        );
        let v = profile(&pending).await.json();
        assert_eq!(v["relationship_state"], "REQUESTED");
        assert!(v.get("bio").is_none() && v.get("last_logged_at").is_none());
        let v = profile(&viewer).await.json();
        assert_eq!((v["relationship_state"].as_str(), v["bio"].as_str()), (Some("NONE"), Some("my bio")));
        assert!(v.get("last_logged_at").is_none());

        let resp = env.call("GET", "/api/users/abc/profile", Some(&viewer), None).await;
        resp.assert_error(400, "INVALID_REQUEST", "Invalid user ID");
        let resp = env.call("GET", &format!("/api/users/{}/profile", viewer.id + 400), Some(&viewer), None).await;
        resp.assert_error(404, "USER_NOT_FOUND", "User not found");

        // Viewing someone else's profile records a recent search in the background; viewing your
        // own does not.
        let searches = |viewer: i64, target: i64| {
            env.count(&format!(
                "SELECT count(*) FROM recent_searches WHERE user_id = {viewer} AND searched_user_id = {target}"
            ))
        };
        eventually("recent search recorded", || async { searches(viewer.id, public.id).await == 1 }).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(searches(viewer.id, viewer.id).await, 0);
        env.finish().await;
    });
}

#[test]
fn search_users() {
    run(async {
        let Some(env) = Env::new("profile_search").await else { return };
        redis_ready().await;
        let named = |name: &str, private: bool, bio: Option<&str>| UserOpts {
            username: Some(name.into()),
            private,
            bio: bio.map(Into::into),
            ..Default::default()
        };
        let viewer = env.user(named("searcher", false, None)).await;
        env.user(named("gopher_public", false, Some("pub bio"))).await;
        let friend = env.user(named("gopher_friend", true, Some("friend bio"))).await;
        env.user(named("gopher_stranger", true, Some("stranger bio"))).await;
        env.user(named("unrelated", false, None)).await;
        env.follow(viewer.id, friend.id, "ACTIVE").await;

        let search = |body: &str| env.call("POST", "/api/users", Some(&viewer), Some(body));
        search(r#"{"username":"#).await.assert_error(400, "INVALID_REQUEST", "Invalid request body");

        let resp = search(r#"{"username":"GOPHER"}"#).await;
        assert_eq!(resp.status, 200);
        let v = resp.json();
        assert_eq!(v["success"], true);
        let bios: BTreeMap<String, Value> = v["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| (u["username"].as_str().unwrap().to_string(), u.get("bio").cloned().unwrap_or(Value::Null)))
            .collect();
        let expected: BTreeMap<String, Value> = [
            ("gopher_public", json!("pub bio")),
            ("gopher_friend", json!("friend bio")),
            ("gopher_stranger", Value::Null),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        assert_eq!(bios, expected);
        assert!(!resp.body.contains("@example.com"), "emails are never exposed");

        let resp = search(r#"{"username":"gopher_friend"}"#).await;
        assert_eq!(
            resp.body,
            format!(
                r#"{{"success":true,"data":[{{"id":{},"username":"gopher_friend","profile_pic":null,"bio":"friend bio","is_private":true,"is_verified":false}}]}}"#,
                friend.id
            )
        );
        for body in [r#"{"username":"zzz"}"#, r#"{"username":""}"#, r#"{"username":" \t\n"}"#, "{}", "null"] {
            assert_eq!(search(body).await.body, r#"{"success":true,"data":[]}"#, "{body}");
        }
        env.finish().await;
    });
}

#[test]
fn autocomplete() {
    run(async {
        let Some(env) = Env::new("profile_autocomplete").await else { return };
        let redis = redis_ready().await;
        let tag = unique_tag();
        let named = |suffix: &str, verified: bool| UserOpts {
            username: Some(format!("{tag}{suffix}")),
            verified,
            ..Default::default()
        };
        let viewer = env.plain_user().await;
        env.user(named("", false)).await;
        let popular = env.user(named("_pro", true)).await;
        env.user(named("_dev", false)).await;
        env.user(UserOpts { username: Some("rustacean".into()), ..Default::default() }).await;
        env.follow(viewer.id, popular.id, "ACTIVE").await;
        let cache_key = format!("autocomplete:users:{tag}");
        let clear_cache = || async {
            if redis {
                redis_del(&cache_key).await;
            }
        };
        let (env_ref, viewer_ref) = (&env, &viewer);
        let complete = move |query: String| {
            env_ref.call("GET", &format!("/api/autocomplete/users?{query}"), Some(viewer_ref), None)
        };

        for query in ["", "q=%20%20"] {
            complete(query.into()).await.assert_error(400, "MISSING_FIELDS", "Query parameter 'q' is required");
        }

        clear_cache().await;
        let resp = complete(format!("q={}", tag.to_uppercase())).await;
        assert_eq!(resp.status, 200);
        let v = resp.json();
        let request_id = v["requestId"].as_str().unwrap().to_string();
        assert!(uuid::Uuid::parse_str(&request_id).is_ok());
        let texts: Vec<&str> =
            v["suggestions"].as_array().unwrap().iter().map(|s| s["text"].as_str().unwrap()).collect();
        assert_eq!(texts, vec![tag.clone(), format!("{tag}_pro"), format!("{tag}_dev")]);
        assert_eq!(v["query"], tag.to_uppercase());
        assert_eq!(v["suggestions"][0]["score"], 100);
        assert!(v["suggestions"][1]["score"].as_f64().unwrap() > 50.0);
        assert_eq!(v["suggestions"][1]["meta"], json!({ "isVerified": true, "followersCount": 1 }));
        assert!(v["suggestions"].as_array().unwrap().iter().all(|s| s["kind"] == "user"));

        if redis {
            // Cached under the lower-cased query, without the request id.
            let cached = redis_get(&cache_key).await.expect("cached");
            assert_eq!(cached, resp.body.replace(&request_id, ""));
            sqlx::query("UPDATE users SET username = $1 WHERE id = $2")
                .bind(format!("{tag}_renamed"))
                .bind(popular.id)
                .execute(env.pool())
                .await
                .unwrap();
            let hit = complete(format!("q={tag}")).await;
            let hit_id = hit.json()["requestId"].as_str().unwrap().to_string();
            assert_ne!(hit_id, request_id, "each response gets a fresh request id");
            assert_eq!(hit.body.replace(&hit_id, ""), cached, "a cache hit echoes the cached response");

            // An entry written by the Go backend round-trips byte for byte.
            let go_cached = r#"{"query":"Ali","requestId":"","suggestions":[{"text":"alice","kind":"user","score":62.857142984867096,"meta":{"profilePic":"http://p/a.jpg","isVerified":false,"followersCount":0}}]}"#;
            redis_set(&cache_key, go_cached).await;
            let hit = complete(format!("q={tag}")).await;
            let hit_id = hit.json()["requestId"].as_str().unwrap().to_string();
            assert_eq!(hit.body.replace(&hit_id, ""), go_cached);

            // A corrupt entry falls back to the database.
            redis_set(&cache_key, "{not json").await;
            let v = complete(format!("q={tag}")).await.json();
            assert_eq!(v["suggestions"].as_array().unwrap().len(), 3);
        }

        for (limit, want) in [("1", 1), ("0", 3), ("21", 3), ("abc", 3)] {
            clear_cache().await;
            let v = complete(format!("q={tag}&limit={limit}")).await.json();
            assert_eq!(v["suggestions"].as_array().unwrap().len(), want, "limit={limit}");
        }
        clear_cache().await;

        // Queries are cut to 80 characters, never inside a multi-byte character.
        for (query, want) in [
            ("q".repeat(100), "q".repeat(80)),
            (format!("a{}", "é".repeat(100)), format!("a{}", "é".repeat(79))),
            ("€".repeat(100), "€".repeat(80)),
            ("🚀".repeat(100), "🚀".repeat(80)),
        ] {
            let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
            let v = complete(format!("q={encoded}")).await.json();
            assert_eq!(v["query"], want);
            assert!(v["suggestions"].is_array());
            if redis {
                redis_del(&format!("autocomplete:users:{want}")).await;
            }
        }
        env.finish().await;
    });
}
