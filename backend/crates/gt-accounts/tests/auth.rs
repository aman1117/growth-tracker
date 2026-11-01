//! `/api/register`, `/api/login`, `/api/update-username`, `/api/change-password` (port of
//! `auth_test.go` and `token_test.go`).

mod common;

use std::sync::Arc;

use chrono::{DateTime, Utc};
use common::{
    redis_get, redis_ready, redis_ttl, request, run, send, Env, MailRecorder, UserOpts, FRONTEND_URL, TEST_PASSWORD,
};
use gt_users::service::verify_password;
use serde_json::json;

fn register_body(email: &str, username: &str, password: &str) -> String {
    json!({ "email": email, "username": username, "password": password }).to_string()
}

#[test]
fn register_rejects_invalid_input() {
    run(async {
        let Some(env) = Env::new("auth_register_invalid").await else { return };
        let existing = env.user(UserOpts { username: Some("taken_name".into()), ..Default::default() }).await;

        let text_plain = axum::http::Request::post("/api/register")
            .header("Content-Type", "text/plain")
            .body(axum::body::Body::from("email=a@b.c"))
            .unwrap();
        send(&env.app, text_plain).await.assert_error(400, "INVALID_REQUEST", "Invalid request body");

        let cases: Vec<(String, &str, &str)> = vec![
            (r#"{"email":"#.into(), "INVALID_REQUEST", "Invalid request body"),
            (register_body("", "newbie", "Password1"), "MISSING_FIELDS", "All fields are required"),
            (register_body("n@example.com", "", "Password1"), "MISSING_FIELDS", "All fields are required"),
            (register_body("n@example.com", "newbie", ""), "MISSING_FIELDS", "All fields are required"),
            (
                r#"{"email":null,"username":"newbie","password":"Password1"}"#.into(),
                "MISSING_FIELDS",
                "All fields are required",
            ),
            (register_body("n@example.com", "newbie", "         "), "MISSING_FIELDS", "Password is required"),
            (
                register_body("n@example.com", "newbie", "Short1"),
                "PASSWORD_TOO_SHORT",
                "Password must be at least 8 characters long",
            ),
            (
                register_body("n@example.com", "ab", "Password1"),
                "INVALID_USERNAME_LENGTH",
                "Username must be between 3 and 20 characters",
            ),
            (
                register_body("n@example.com", "abcdefghijklmnopqrstu", "Password1"),
                "INVALID_USERNAME_LENGTH",
                "Username must be between 3 and 20 characters",
            ),
            (
                register_body("n@example.com", "bad name", "Password1"),
                "INVALID_USERNAME_FORMAT",
                "Username can only contain lowercase letters, numbers, _ and .",
            ),
            (
                register_body("n@example.com", "jürgen", "Password1"),
                "INVALID_USERNAME_FORMAT",
                "Username can only contain lowercase letters, numbers, _ and .",
            ),
            (
                register_body(&existing.email, "fresh_name", "Password1"),
                "USER_EXISTS",
                "Could not create user (maybe email/username already used)",
            ),
            (
                register_body("other@example.com", "TAKEN_NAME", "Password1"),
                "USER_EXISTS",
                "Could not create user (maybe email/username already used)",
            ),
            (
                register_body("long@example.com", "longpass", &"p".repeat(73)),
                "USER_EXISTS",
                "Could not create user (maybe email/username already used)",
            ),
        ];
        for (body, code, message) in cases {
            env.call("POST", "/api/register", None, Some(&body)).await.assert_error(400, code, message);
        }
        assert_eq!(env.count("SELECT count(*) FROM users").await, 1, "no user may be created by a rejected request");
        assert!(env.mail.sent().is_empty());
        env.finish().await;
    });
}

#[test]
fn register_creates_normalised_user_and_sends_verification() {
    run(async {
        let Some(env) = Env::new("auth_register_ok").await else { return };
        let redis = redis_ready().await;

        let body = register_body("  new@example.com ", "  New_User.1 ", "Secret123");
        env.call("POST", "/api/register", None, Some(&body)).await.assert_success(201, "User created successfully.");

        let user = env.users.user_repo.find_by_username("new_user.1").await.unwrap().expect("user created");
        assert_eq!(user.email, "new@example.com");
        assert!(!user.email_verified && !user.is_private);
        assert!(user.password_hash.starts_with("$2a$10$"));
        assert!(verify_password("Secret123", &user.password_hash).await);
        let counters = env.count(&format!("SELECT count(*) FROM follow_counters WHERE user_id = {}", user.id)).await;
        assert_eq!(counters, 1);

        if redis {
            let mail = env.mail.wait_for(1).await;
            assert_eq!(mail.to, vec!["new@example.com".to_string()]);
            assert_eq!(mail.subject, "Verify Your Email - Growth Tracker");
            assert!(mail.html.contains(&format!("{FRONTEND_URL}/verify-email?token=")));
            assert!(mail.html.contains("Hi <strong>new_user.1</strong>"));
            let token = mail.token();
            let key = format!("verify:{}", gt_core::redis::hash_token(&token));
            assert_eq!(redis_get(&key).await, Some(user.id.to_string()), "only the token hash is stored");
            assert!((86_399..=86_400).contains(&redis_ttl(&key).await));

            // The emailed link verifies the account.
            let resp =
                env.call("POST", "/api/auth/verify-email", None, Some(&json!({ "token": token }).to_string())).await;
            assert_eq!(resp.body, r#"{"message":"Your email has been verified successfully.","success":true}"#);
            assert!(env.users.user_repo.find_by_id(user.id).await.unwrap().unwrap().email_verified);
        }
        env.finish().await;
    });
}

#[test]
fn registration_succeeds_when_the_email_cannot_be_sent() {
    run(async {
        let mail = Arc::new(MailRecorder::rejecting());
        let Some(env) = Env::with("auth_register_mail_fails", common::config(), mail).await else { return };
        redis_ready().await;

        let body = register_body("rejected@example.com", "rejected", "Secret123");
        env.call("POST", "/api/register", None, Some(&body)).await.assert_success(201, "User created successfully.");

        // Without an email service nothing is sent at all.
        let mut users = env.users.clone();
        users.email_service = None;
        let app = env.app_with(&users);
        let resp = send(
            &app,
            request("POST", "/api/register", None, Some(&register_body("quiet@example.com", "quiet", "Secret123"))),
        )
        .await;
        resp.assert_success(201, "User created successfully.");
        assert_eq!(env.count("SELECT count(*) FROM users").await, 2);
        env.finish().await;
    });
}

#[test]
fn login() {
    run(async {
        let Some(env) = Env::new("auth_login").await else { return };
        let user = env.plain_user().await;

        let wrong = json!({ "identifier": user.username, "password": "Wrong123!" }).to_string();
        for (body, code, message) in [
            (r#"{"identifier""#.to_string(), "INVALID_REQUEST", "Invalid request body"),
            (json!({ "password": TEST_PASSWORD }).to_string(), "MISSING_FIELDS", "All fields are required"),
            (json!({ "identifier": user.username }).to_string(), "MISSING_FIELDS", "All fields are required"),
            (
                json!({ "identifier": "nobody", "password": TEST_PASSWORD }).to_string(),
                "INVALID_CREDENTIALS",
                "Invalid credentials",
            ),
            (wrong, "INVALID_PASSWORD", "Invalid password"),
        ] {
            env.call("POST", "/api/login", None, Some(&body)).await.assert_error(400, code, message);
        }

        for identifier in [&user.username, &user.email] {
            let before = Utc::now();
            let body = json!({ "identifier": identifier, "password": TEST_PASSWORD }).to_string();
            let resp = env.call("POST", "/api/login", None, Some(&body)).await;
            assert_eq!(resp.status, 200, "{}", resp.body);
            let v = resp.json();
            let token = v["access_token"].as_str().unwrap();
            let expires_at = v["expires_at"].as_str().unwrap();
            assert_eq!(
                resp.body,
                format!(
                    r#"{{"success":true,"access_token":"{token}","token_type":"Bearer","expires_at":"{expires_at}","expires_in":86400}}"#
                )
            );
            // RFC 3339 in UTC with whole seconds, 24 h ahead.
            assert!(expires_at.ends_with('Z') && expires_at.len() == 20, "{expires_at}");
            let expires: DateTime<Utc> = expires_at.parse().unwrap();
            assert!((expires - before - chrono::Duration::hours(24)).num_seconds().abs() <= 5);

            let claims = env.core.tokens.parse(token).unwrap();
            assert_eq!((claims.user_id, claims.username.as_str()), (user.id as u64, user.username.as_str()));
            // The token works on guarded routes.
            assert_eq!(send(&env.app, request("GET", "/api/get-privacy", Some(token), None)).await.status, 200);
        }
        env.finish().await;
    });
}

#[test]
fn login_token_generation_failure() {
    run(async {
        let mut config = common::config();
        config.jwt.secret_key = String::new();
        let Some(env) = Env::with("auth_login_no_secret", config, Arc::new(MailRecorder::default())).await else {
            return;
        };
        let user = env.plain_user().await;

        let body = json!({ "identifier": user.username, "password": TEST_PASSWORD }).to_string();
        let resp = env.call("POST", "/api/login", None, Some(&body)).await;
        resp.assert_error(400, "TOKEN_GENERATION_FAILED", "Failed to generate token");
        env.finish().await;
    });
}

#[test]
fn update_username() {
    run(async {
        let Some(env) = Env::new("auth_update_username").await else { return };
        let user = env.plain_user().await;
        let other = env.user(UserOpts { username: Some("already_taken".into()), ..Default::default() }).await;

        for (body, code, message) in [
            (r#"{"new_username":"#.to_string(), "INVALID_REQUEST", "Invalid request body"),
            (json!({ "new_username": "   " }).to_string(), "MISSING_FIELDS", "Username is required"),
            (
                json!({ "new_username": "abcdefghijklmnopqrstu" }).to_string(),
                "INVALID_USERNAME_LENGTH",
                "Username must be between 3 and 20 characters",
            ),
            (
                json!({ "new_username": "no-dashes" }).to_string(),
                "INVALID_USERNAME_FORMAT",
                "Username can only contain lowercase letters, numbers, _ and .",
            ),
            (
                json!({ "new_username": other.username }).to_string(),
                "USERNAME_TAKEN",
                "Username already taken or update failed",
            ),
        ] {
            env.call("POST", "/api/update-username", Some(&user), Some(&body)).await.assert_error(400, code, message);
        }

        let body = json!({ "new_username": "  Fresh.Name_1 " }).to_string();
        let resp = env.call("POST", "/api/update-username", Some(&user), Some(&body)).await;
        assert_eq!(resp.status, 200);
        assert_eq!(
            resp.body,
            r#"{"success":true,"message":"Username updated successfully","new_username":"fresh.name_1"}"#
        );
        assert_eq!(env.users.user_repo.find_by_id(user.id).await.unwrap().unwrap().username, "fresh.name_1");
        env.finish().await;
    });
}

#[test]
fn change_password() {
    run(async {
        let Some(env) = Env::new("auth_change_password").await else { return };
        let user = env.plain_user().await;

        let body = |current: Option<&str>, new: Option<&str>| {
            let mut v = json!({});
            if let Some(c) = current {
                v["current_password"] = json!(c);
            }
            if let Some(n) = new {
                v["new_password"] = json!(n);
            }
            v.to_string()
        };
        for (body, code, message) in [
            (r#"{"current_password":"#.to_string(), "INVALID_REQUEST", "Invalid request body"),
            (body(None, Some("NewPass123")), "MISSING_FIELDS", "All fields are required"),
            (body(Some(TEST_PASSWORD), None), "MISSING_FIELDS", "All fields are required"),
            (
                body(Some(TEST_PASSWORD), Some("short")),
                "PASSWORD_TOO_SHORT",
                "Password must be at least 8 characters long",
            ),
            (body(Some("Nope12345"), Some("NewPass123")), "INVALID_PASSWORD", "Current password is incorrect"),
        ] {
            env.call("POST", "/api/change-password", Some(&user), Some(&body)).await.assert_error(400, code, message);
        }

        let resp = env
            .call("POST", "/api/change-password", Some(&user), Some(&body(Some(TEST_PASSWORD), Some("BrandNew123"))))
            .await;
        resp.assert_success(200, "Password changed successfully");
        let login = |password: &str| json!({ "identifier": user.username, "password": password }).to_string();
        assert_eq!(env.call("POST", "/api/login", None, Some(&login("BrandNew123"))).await.status, 200);
        env.call("POST", "/api/login", None, Some(&login(TEST_PASSWORD))).await.assert_error(
            400,
            "INVALID_PASSWORD",
            "Invalid password",
        );

        // A token for a user that does not exist.
        let ghost = env.token(user.id + 400, "ghost");
        let req = request(
            "POST",
            "/api/change-password",
            Some(&ghost),
            Some(&body(Some(TEST_PASSWORD), Some("BrandNew123"))),
        );
        send(&env.app, req).await.assert_error(500, "UPDATE_FAILED", "Failed to update password");
        env.finish().await;
    });
}
