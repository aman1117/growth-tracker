//! Password reset and email verification against Redis (port of `password_reset_test.go` and
//! `verification_test.go`).

mod common;

use std::sync::Arc;

use common::{
    redis_del, redis_get, redis_ready, redis_set, redis_ttl, request, run, send, Broken, Env, MailRecorder, UserOpts,
    FRONTEND_URL,
};
use gt_core::redis as gt_redis;
use serde_json::json;

const GENERIC_FORGOT: &str =
    r#"{"message":"If an account exists with this email, a password reset link has been sent.","success":true}"#;

fn reset_body(token: &str, password: &str, confirm: &str) -> String {
    json!({ "token": token, "new_password": password, "confirm_password": confirm }).to_string()
}

async fn issue_reset_token(user_id: i64) -> String {
    let (raw, hash) = gt_redis::generate_reset_token();
    gt_redis::store_reset_token(&hash, user_id).await.unwrap();
    raw
}

async fn issue_verify_token(user_id: i64) -> String {
    let (raw, hash) = gt_redis::generate_verify_token();
    gt_redis::store_verify_token(&hash, user_id).await.unwrap();
    raw
}

fn reset_key(token: &str) -> String {
    format!("reset:{}", gt_redis::hash_token(token))
}

fn verify_key(token: &str) -> String {
    format!("verify:{}", gt_redis::hash_token(token))
}

#[test]
fn forgot_password_flow() {
    run(async {
        let Some(env) = Env::new("email_forgot").await else { return };
        if !redis_ready().await {
            return env.finish().await;
        }
        let user = env.plain_user().await;

        for body in [r#"{"email":"#, r#"{"email":""}"#, r#"{"email":"nobody@example.com"}"#] {
            let resp = env.call("POST", "/api/auth/forgot-password", None, Some(body)).await;
            assert_eq!((resp.status, resp.body.as_str()), (200, GENERIC_FORGOT));
        }
        assert!(env.mail.sent().is_empty());

        let body = json!({ "email": user.email }).to_string();
        let resp = env.call("POST", "/api/auth/forgot-password", None, Some(&body)).await;
        assert_eq!((resp.status, resp.body.as_str()), (200, GENERIC_FORGOT));
        let mail = env.mail.wait_for(1).await;
        assert_eq!(mail.to, vec![user.email.clone()]);
        assert_eq!(mail.subject, "Reset Your Password - Growth Tracker");
        assert!(mail.html.contains(&format!("{FRONTEND_URL}/reset-password?token=")));
        let token = mail.token();
        assert_eq!(redis_get(&reset_key(&token)).await, Some(user.id.to_string()), "only the token hash is stored");
        assert!((899..=900).contains(&redis_ttl(&reset_key(&token)).await));

        let validate = format!("/api/auth/reset-password/validate?token={token}");
        assert_eq!(env.call("GET", &validate, None, None).await.body, r#"{"success":true,"valid":true}"#);
        let resp = env
            .call("POST", "/api/auth/reset-password", None, Some(&reset_body(&token, "Fresh1234", "Fresh1234")))
            .await;
        resp.assert_success(200, "Password updated successfully. You can now log in with your new password.");
        let login = json!({ "identifier": user.email, "password": "Fresh1234" }).to_string();
        assert_eq!(env.call("POST", "/api/login", None, Some(&login)).await.status, 200, "the new password works");
        env.finish().await;
    });
}

#[test]
fn forgot_password_hides_delivery_failures() {
    run(async {
        let mail = Arc::new(MailRecorder::rejecting());
        let Some(env) = Env::with("email_forgot_failures", common::config(), mail).await else { return };
        if !redis_ready().await {
            return env.finish().await;
        }
        let user = env.plain_user().await;
        let body = json!({ "email": user.email }).to_string();

        // The mailer rejects the message: same answer, token still issued.
        let resp = env.call("POST", "/api/auth/forgot-password", None, Some(&body)).await;
        assert_eq!((resp.status, resp.body.as_str()), (200, GENERIC_FORGOT));
        let token = env.mail.wait_for(1).await.token();
        assert_eq!(redis_get(&reset_key(&token)).await, Some(user.id.to_string()));

        // No email service: same answer.
        let mut users = env.users.clone();
        users.email_service = None;
        let resp = send(&env.app_with(&users), request("POST", "/api/auth/forgot-password", None, Some(&body))).await;
        assert_eq!((resp.status, resp.body.as_str()), (200, GENERIC_FORGOT));

        // Database failure: same answer.
        let resp = Broken::new().call("POST", "/api/auth/forgot-password", None, Some(&body)).await;
        assert_eq!((resp.status, resp.body.as_str()), (200, GENERIC_FORGOT));
        env.finish().await;
    });
}

#[test]
fn reset_password() {
    run(async {
        let Some(env) = Env::new("email_reset").await else { return };
        if !redis_ready().await {
            return env.finish().await;
        }
        let user = env.plain_user().await;
        let env_ref = &env;
        let reset = move |body: String| env_ref.call("POST", "/api/auth/reset-password", None, Some(&body));

        for (body, code, message) in [
            (r#"{"token":"#.to_string(), "INVALID_REQUEST", "Invalid request body"),
            (reset_body("", "Fresh1234", "Fresh1234"), "MISSING_TOKEN", "Reset token is required"),
            (reset_body("tok", "Fresh1234", "Fresh12345"), "PASSWORD_MISMATCH", "Passwords do not match"),
            (reset_body("tok", "Ab1", "Ab1"), "PASSWORD_TOO_SHORT", "Password must be at least 8 characters long"),
            (
                reset_body("tok", "OnlyLetters", "OnlyLetters"),
                "WEAK_PASSWORD",
                "Password must contain at least one number",
            ),
            (reset_body("tok", "12345678", "12345678"), "WEAK_PASSWORD", "Password must contain at least one letter"),
            (reset_body("deadbeef", "Fresh1234", "Fresh1234"), "INVALID_TOKEN", "Invalid or expired reset token"),
        ] {
            reset(body).await.assert_error(400, code, message);
        }

        // A token works exactly once.
        let token = issue_reset_token(user.id).await;
        reset(reset_body(&token, "Fresh1234", "Fresh1234"))
            .await
            .assert_success(200, "Password updated successfully. You can now log in with your new password.");
        assert_eq!(redis_get(&reset_key(&token)).await, None);
        let login = json!({ "identifier": user.username, "password": "Fresh1234" }).to_string();
        assert_eq!(env.call("POST", "/api/login", None, Some(&login)).await.status, 200);
        reset(reset_body(&token, "Other1234", "Other1234")).await.assert_error(
            400,
            "INVALID_TOKEN",
            "Invalid or expired reset token",
        );

        // An expired token is gone from Redis.
        let token = issue_reset_token(user.id).await;
        redis_del(&reset_key(&token)).await;
        reset(reset_body(&token, "Fresh1234", "Fresh1234")).await.assert_error(
            400,
            "INVALID_TOKEN",
            "Invalid or expired reset token",
        );

        // A corrupt stored value is a server error.
        let token = issue_reset_token(user.id).await;
        redis_set(&reset_key(&token), "not-a-number").await;
        reset(reset_body(&token, "Fresh1234", "Fresh1234")).await.assert_error(
            500,
            "SERVER_ERROR",
            "An error occurred. Please try again.",
        );
        redis_del(&reset_key(&token)).await;

        // The token is consumed before the update, which then fails.
        let token = issue_reset_token(user.id).await;
        let resp = Broken::new()
            .call("POST", "/api/auth/reset-password", None, Some(&reset_body(&token, "Fresh1234", "Fresh1234")))
            .await;
        resp.assert_error(500, "UPDATE_FAILED", "Failed to update password");
        assert_eq!(redis_get(&reset_key(&token)).await, None);
        env.finish().await;
    });
}

#[test]
fn validate_reset_token() {
    run(async {
        let Some(env) = Env::new("email_validate").await else { return };
        if !redis_ready().await {
            return env.finish().await;
        }
        let invalid = r#"{"success":true,"valid":false}"#;
        for uri in [
            "/api/auth/reset-password/validate",
            "/api/auth/reset-password/validate?token=",
            "/api/auth/reset-password/validate?token=unknown",
        ] {
            assert_eq!(env.call("GET", uri, None, None).await.body, invalid, "{uri}");
        }
        let token = issue_reset_token(3).await;
        for _ in 0..2 {
            let resp = env.call("GET", &format!("/api/auth/reset-password/validate?token={token}"), None, None).await;
            assert_eq!(resp.body, r#"{"success":true,"valid":true}"#);
        }
        assert_eq!(redis_get(&reset_key(&token)).await.as_deref(), Some("3"), "validation does not consume the token");
        redis_del(&reset_key(&token)).await;
        env.finish().await;
    });
}

#[test]
fn verify_email() {
    run(async {
        let Some(env) = Env::new("email_verify").await else { return };
        if !redis_ready().await {
            return env.finish().await;
        }
        let unverified = env.user(UserOpts { email_verified: false, ..Default::default() }).await;
        let verified = env.plain_user().await;
        let verify = |token: &str| {
            env.call("POST", "/api/auth/verify-email", None, Some(&json!({ "token": token }).to_string()))
        };

        env.call("POST", "/api/auth/verify-email", None, Some(r#"{"token":"#)).await.assert_error(
            400,
            "INVALID_REQUEST",
            "Invalid request body",
        );
        verify("").await.assert_error(400, "MISSING_TOKEN", "Verification token is required");

        let token = issue_verify_token(unverified.id).await;
        let resp = verify(&token).await;
        assert_eq!(
            (resp.status, resp.body.as_str()),
            (200, r#"{"message":"Your email has been verified successfully.","success":true}"#)
        );
        assert!(env.users.user_repo.find_by_id(unverified.id).await.unwrap().unwrap().email_verified);
        assert_eq!(redis_get(&verify_key(&token)).await, None, "the token is single-use");
        verify(&token).await.assert_error(400, "INVALID_VERIFY_TOKEN", "Invalid or expired verification link");

        let token = issue_verify_token(verified.id).await;
        let resp = verify(&token).await;
        assert_eq!(
            (resp.status, resp.body.as_str()),
            (200, r#"{"already_verified":true,"message":"Your email has been verified successfully.","success":true}"#)
        );

        let token = issue_verify_token(unverified.id).await;
        redis_del(&verify_key(&token)).await;
        verify(&token).await.assert_error(400, "INVALID_VERIFY_TOKEN", "Invalid or expired verification link");

        let token = issue_verify_token(unverified.id + 400).await;
        verify(&token).await.assert_error(400, "USER_NOT_FOUND", "User not found");

        let token = issue_verify_token(unverified.id).await;
        redis_set(&verify_key(&token), "not-a-number").await;
        verify(&token).await.assert_error(500, "SERVER_ERROR", "An error occurred. Please try again.");

        // The user lookup fails.
        let token = issue_verify_token(unverified.id).await;
        let resp = Broken::new()
            .call("POST", "/api/auth/verify-email", None, Some(&json!({ "token": token }).to_string()))
            .await;
        resp.assert_error(500, "SERVER_ERROR", "An error occurred. Please try again.");
        env.finish().await;
    });
}

#[test]
fn resend_verification_email() {
    run(async {
        let Some(env) = Env::new("email_resend").await else { return };
        if !redis_ready().await {
            return env.finish().await;
        }
        let unverified = env.user(UserOpts { email_verified: false, ..Default::default() }).await;
        let verified = env.plain_user().await;
        let cooldown_key = format!("verify_cooldown:{}", unverified.id);
        redis_del(&cooldown_key).await;
        let resend = |token: &str| send(&env.app, request("POST", "/api/auth/resend-verification", Some(token), None));

        resend(&env.token(unverified.id + 400, "ghost")).await.assert_error(400, "USER_NOT_FOUND", "User not found");
        resend(&verified.token).await.assert_error(400, "ALREADY_VERIFIED", "Email is already verified");
        assert!(env.mail.sent().is_empty());

        resend(&unverified.token).await.assert_success(200, "Verification email sent. Please check your inbox.");
        let mail = env.mail.wait_for(1).await;
        assert_eq!(mail.to, vec![unverified.email.clone()]);
        assert_eq!(redis_get(&verify_key(&mail.token())).await, Some(unverified.id.to_string()));
        assert!((119..=120).contains(&redis_ttl(&cooldown_key).await));

        resend(&unverified.token).await.assert_error(
            400,
            "VERIFY_RESEND_COOLDOWN",
            "Please wait before requesting another verification email",
        );
        assert_eq!(env.mail.sent().len(), 1);

        // After the cooldown (expired key) another email goes out.
        redis_del(&cooldown_key).await;
        resend(&unverified.token).await.assert_success(200, "Verification email sent. Please check your inbox.");
        env.mail.wait_for(2).await;

        // A failing mailer is reported; without an email service the token is still issued.
        redis_del(&cooldown_key).await;
        let rejecting = Arc::new(MailRecorder::rejecting());
        let mut users = env.users.clone();
        users.email_service = Some(Arc::new(gt_users::EmailService::with_sender(
            rejecting.clone(),
            &env.core.config.email,
            FRONTEND_URL,
        )));
        let resp = send(
            &env.app_with(&users),
            request("POST", "/api/auth/resend-verification", Some(&unverified.token), None),
        )
        .await;
        resp.assert_error(500, "SERVER_ERROR", "Failed to send verification email");
        redis_del(&cooldown_key).await;
        users.email_service = None;
        let resp = send(
            &env.app_with(&users),
            request("POST", "/api/auth/resend-verification", Some(&unverified.token), None),
        )
        .await;
        resp.assert_success(200, "Verification email sent. Please check your inbox.");
        assert!(redis_get(&cooldown_key).await.is_some());
        redis_del(&cooldown_key).await;

        // The user lookup fails.
        let resp = Broken::new().call("POST", "/api/auth/resend-verification", Some(unverified.id), None).await;
        resp.assert_error(500, "SERVER_ERROR", "An error occurred. Please try again.");
        env.finish().await;
    });
}
