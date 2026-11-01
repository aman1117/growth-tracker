//! `EmailService` (port of the email part of `internal/services/email.go`): password reset and
//! verification emails, sent through Resend in production or SMTP (Mailpit) in development.

mod resend;
mod smtp;
mod templates;

use std::sync::Arc;

use async_trait::async_trait;
use gt_core::config::EmailConfig;

pub use resend::ResendEmailSender;
pub use smtp::SmtpEmailSender;

/// Subject of the password reset email.
pub const PASSWORD_RESET_SUBJECT: &str = "Reset Your Password - Growth Tracker";
/// Subject of the email verification email.
pub const VERIFICATION_SUBJECT: &str = "Verify Your Email - Growth Tracker";

/// A failed send. The message is what the Go sender returned (e.g. `[ERROR]: Invalid to field`
/// from Resend, the server reply for SMTP).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct EmailError(pub String);

impl EmailError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// Something that delivers an HTML email (Go `EmailSender`).
#[async_trait]
pub trait EmailSender: Send + Sync + std::fmt::Debug {
    /// Sends `html_body` with `subject` to every address in `to`.
    async fn send(&self, to: &[String], subject: &str, html_body: &str) -> Result<(), EmailError>;
}

/// Transactional emails.
#[derive(Debug, Clone)]
pub struct EmailService {
    sender: Arc<dyn EmailSender>,
    from_address: String,
    from_name: String,
    frontend_url: String,
}

impl EmailService {
    /// Resend when `RESEND_API_KEY` is set, otherwise SMTP from `SMTP_HOST` (default `localhost`)
    /// and `SMTP_PORT` (default `1025`, Mailpit). Go's constructor never failed; an error here
    /// only means the HTTP client could not be built, and callers treat the service as
    /// unavailable (`None`).
    pub fn new(cfg: &EmailConfig, frontend_url: &str) -> Result<Self, EmailError> {
        let sender: Arc<dyn EmailSender> = if cfg.resend_api_key.is_empty() {
            let sender = SmtpEmailSender::from_env(&cfg.from_address, &cfg.from_name);
            tracing::info!(host = sender.host(), port = sender.port(), "Email service initialized with SMTP (Mailpit)");
            Arc::new(sender)
        } else {
            let sender = ResendEmailSender::new(&cfg.resend_api_key, &cfg.from_address, &cfg.from_name)?;
            tracing::info!("Email service initialized with Resend API");
            Arc::new(sender)
        };
        Ok(Self::with_sender(sender, cfg, frontend_url))
    }

    /// A service using `sender` (tests, or a custom transport).
    pub fn with_sender(sender: Arc<dyn EmailSender>, cfg: &EmailConfig, frontend_url: &str) -> Self {
        Self {
            sender,
            from_address: cfg.from_address.clone(),
            from_name: cfg.from_name.clone(),
            frontend_url: frontend_url.to_string(),
        }
    }

    /// The transport in use.
    pub fn sender(&self) -> &Arc<dyn EmailSender> {
        &self.sender
    }

    /// The configured sender address.
    pub fn from_address(&self) -> &str {
        &self.from_address
    }

    /// The configured sender display name.
    pub fn from_name(&self) -> &str {
        &self.from_name
    }

    /// The frontend base URL used in links.
    pub fn frontend_url(&self) -> &str {
        &self.frontend_url
    }

    /// Sends the password reset email with a link to `<frontend>/reset-password?token=<token>`.
    pub async fn send_password_reset_email(&self, email: &str, username: &str, token: &str) -> Result<(), EmailError> {
        let reset_link = format!("{}/reset-password?token={token}", self.frontend_url);
        let html = self.build_password_reset_html(username, &reset_link);
        self.sender.send(&[email.to_string()], PASSWORD_RESET_SUBJECT, &html).await
    }

    /// Sends the verification email with a link to `<frontend>/verify-email?token=<token>`.
    pub async fn send_verification_email(&self, email: &str, username: &str, token: &str) -> Result<(), EmailError> {
        let verify_link = format!("{}/verify-email?token={token}", self.frontend_url);
        let html = self.build_verification_email_html(username, &verify_link);
        self.sender.send(&[email.to_string()], VERIFICATION_SUBJECT, &html).await
    }

    /// The verification email body (byte-identical to Go's).
    pub fn build_verification_email_html(&self, username: &str, verify_link: &str) -> String {
        templates::sprintf_s(
            templates::VERIFICATION_EMAIL_FORMAT,
            &[username, verify_link, verify_link, verify_link, &self.frontend_url],
        )
    }

    /// The password reset email body (byte-identical to Go's).
    pub fn build_password_reset_html(&self, username: &str, reset_link: &str) -> String {
        templates::sprintf_s(
            templates::PASSWORD_RESET_EMAIL_FORMAT,
            &[username, reset_link, reset_link, reset_link, &self.frontend_url],
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use sha2::{Digest, Sha256};

    use super::*;

    const FRONTEND: &str = "https://app.example.com";

    fn config() -> EmailConfig {
        EmailConfig {
            resend_api_key: String::new(),
            from_address: "noreply@example.com".into(),
            from_name: "Growth Tracker".into(),
        }
    }

    #[derive(Debug, Default)]
    struct Recorder(Mutex<Vec<(Vec<String>, String, String)>>);

    #[async_trait]
    impl EmailSender for Recorder {
        async fn send(&self, to: &[String], subject: &str, html_body: &str) -> Result<(), EmailError> {
            self.0.lock().unwrap().push((to.to_vec(), subject.to_string(), html_body.to_string()));
            Ok(())
        }
    }

    fn sha256(s: &str) -> String {
        Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn templates_are_byte_identical_to_go() {
        let svc = EmailService::with_sender(Arc::new(Recorder::default()), &config(), FRONTEND);
        // Digests of Go's fmt.Sprintf output for the same arguments.
        let verify = svc.build_verification_email_html("ada", "https://app.example.com/verify-email?token=abc123");
        assert_eq!(verify.len(), 3813);
        assert_eq!(sha256(&verify), "203368b8d5695b332b51f63b8ae426f55a3b75242d238a9c0ff83cc7e87e9ece");
        let reset = svc.build_password_reset_html("bob", "https://app.example.com/reset-password?token=t0k");
        assert_eq!(reset.len(), 3862);
        assert_eq!(sha256(&reset), "3370cacaf71df179ddaace37544f29ec5419f03eccab55ac8c299f0886501a45");

        assert!(verify.starts_with("\n<!DOCTYPE html>\n"));
        assert!(verify.ends_with("</html>\n"));
        assert!(reset.contains(r#"<table width="100%" cellpadding="0""#), "%% renders as %");
        assert!(reset.contains("Hi <strong>bob</strong>,"));
        assert!(reset.contains(r#"<a href="https://app.example.com" style="color: #0066ff; text-decoration: none;">"#));
    }

    #[test]
    fn sprintf_handles_missing_arguments_like_go() {
        assert_eq!(templates::sprintf_s("a%sb%%c%s", &["X"]), "aXb%c%!s(MISSING)");
        assert_eq!(templates::sprintf_s("100%", &[]), "100%");
    }

    #[tokio::test]
    async fn sends_with_go_subjects_and_links() {
        let recorder = Arc::new(Recorder::default());
        let svc = EmailService::with_sender(recorder.clone(), &config(), FRONTEND);
        svc.send_password_reset_email("ada@example.com", "ada", "reset-token").await.unwrap();
        svc.send_verification_email("bob@example.com", "bob", "verify-token").await.unwrap();

        let sent = recorder.0.lock().unwrap();
        assert_eq!(sent[0].0, vec!["ada@example.com".to_string()]);
        assert_eq!(sent[0].1, PASSWORD_RESET_SUBJECT);
        assert!(sent[0].2.contains(r#"href="https://app.example.com/reset-password?token=reset-token""#));
        assert!(sent[0].2.contains("15 minutes"));
        assert_eq!(sent[1].1, VERIFICATION_SUBJECT);
        assert!(sent[1].2.contains(r#"href="https://app.example.com/verify-email?token=verify-token""#));
        assert!(sent[1].2.contains("24 hours"));
    }
}
