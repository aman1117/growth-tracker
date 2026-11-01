//! SMTP sender for local development with Mailpit (port of `SMTPEmailSender`, which used Go's
//! `net/smtp.SendMail` without auth). The session mirrors `SendMail`: `EHLO localhost`, STARTTLS
//! when offered (verifying the certificate for the configured host), `MAIL FROM` with
//! `BODY=8BITMIME`/`SMTPUTF8` when advertised, one `RCPT TO` per recipient, and the message
//! written through Go's `textproto` dot-writer encoding.

use std::fmt;

use async_trait::async_trait;
use lettre::transport::smtp::client::{AsyncSmtpConnection, TlsParameters};
use lettre::transport::smtp::extension::{ClientId, Extension};

use super::{EmailError, EmailSender};

const DEFAULT_HOST: &str = "localhost";
const DEFAULT_PORT: &str = "1025";
/// `net/smtp` greets with `EHLO localhost`.
const HELLO_NAME: &str = "localhost";

/// Sends emails over plain SMTP (Mailpit in development).
#[derive(Debug, Clone)]
pub struct SmtpEmailSender {
    host: String,
    port: String,
    from_address: String,
    from_name: String,
}

/// A pre-formatted command line or DATA payload written verbatim.
struct Raw(String);

impl fmt::Display for Raw {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl SmtpEmailSender {
    /// A sender for `host:port`.
    pub fn new(host: &str, port: &str, from_address: &str, from_name: &str) -> Self {
        Self {
            host: host.to_string(),
            port: port.to_string(),
            from_address: from_address.to_string(),
            from_name: from_name.to_string(),
        }
    }

    /// A sender for `SMTP_HOST` (default `localhost`) and `SMTP_PORT` (default `1025`).
    pub fn from_env(from_address: &str, from_name: &str) -> Self {
        let env = |key: &str, default: &str| {
            std::env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
        };
        Self::new(&env("SMTP_HOST", DEFAULT_HOST), &env("SMTP_PORT", DEFAULT_PORT), from_address, from_name)
    }

    /// The SMTP host.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// The SMTP port (as configured, like Go's string port).
    pub fn port(&self) -> &str {
        &self.port
    }

    /// The RFC 5322 message Go builds: a few headers, a blank line and the HTML body.
    fn build_message(&self, to: &[String], subject: &str, html_body: &str) -> String {
        format!(
            "From: {} <{}>\r\nTo: {}\r\nSubject: {subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=\"UTF-8\"\r\n\r\n{html_body}",
            self.from_name,
            self.from_address,
            to.join(", "),
        )
    }

    /// `smtp.SendMail(addr, nil, from, to, msg)`.
    async fn send_mail(&self, to: &[String], message: &str) -> Result<(), EmailError> {
        validate_line(&self.from_address)?;
        for recipient in to {
            validate_line(recipient)?;
        }
        let addr = format!("{}:{}", self.host, self.port);
        let hello = ClientId::Domain(HELLO_NAME.to_string());
        let mut conn =
            AsyncSmtpConnection::connect_tokio1(addr.as_str(), None, &hello, None, None).await.map_err(smtp_error)?;
        if conn.can_starttls() {
            let tls = TlsParameters::new(self.host.clone()).map_err(smtp_error)?;
            conn.starttls(tls, &hello).await.map_err(smtp_error)?;
        }

        let info = conn.server_info();
        let mut mail = format!("MAIL FROM:<{}>", self.from_address);
        if info.supports_feature(Extension::EightBitMime) {
            mail.push_str(" BODY=8BITMIME");
        }
        if info.supports_feature(Extension::SmtpUtfEight) {
            mail.push_str(" SMTPUTF8");
        }
        mail.push_str("\r\n");
        conn.command(Raw(mail)).await.map_err(smtp_error)?;
        for recipient in to {
            conn.command(Raw(format!("RCPT TO:<{recipient}>\r\n"))).await.map_err(smtp_error)?;
        }
        conn.command(Raw("DATA\r\n".to_string())).await.map_err(smtp_error)?;
        conn.command(Raw(dot_encode(message))).await.map_err(smtp_error)?;
        conn.quit().await.map_err(smtp_error)?;
        Ok(())
    }
}

#[async_trait]
impl EmailSender for SmtpEmailSender {
    async fn send(&self, to: &[String], subject: &str, html_body: &str) -> Result<(), EmailError> {
        let message = self.build_message(to, subject, html_body);
        let result = self.send_mail(to, &message).await;
        // Recipients are not logged (PII); Go logged the addresses.
        match &result {
            Ok(()) => tracing::info!(recipients = to.len(), subject, "Email sent via SMTP (Mailpit)"),
            Err(e) => tracing::warn!(error = %e, recipients = to.len(), "SMTP send failed"),
        }
        result
    }
}

fn smtp_error(e: lettre::transport::smtp::Error) -> EmailError {
    EmailError::new(e.to_string())
}

/// `net/smtp.validateLine`.
fn validate_line(line: &str) -> Result<(), EmailError> {
    if line.contains(['\n', '\r']) {
        return Err(EmailError::new("smtp: A line must not contain CR or LF"));
    }
    Ok(())
}

/// Go `textproto.Writer.DotWriter` applied to the whole message, including the terminating
/// `.\r\n`: bare `\n` becomes `\r\n`, a leading `.` on a line is doubled, and an unterminated
/// last line gets a `\r\n` before the final dot.
fn dot_encode(message: &str) -> String {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Begin,
        BeginLine,
        Line,
        Cr,
    }

    let mut out = String::with_capacity(message.len() + message.len() / 16 + 5);
    let mut state = State::Begin;
    for c in message.chars() {
        if matches!(state, State::Begin | State::BeginLine) {
            state = State::Line;
            if c == '.' {
                out.push('.');
            }
        }
        match state {
            State::Line => match c {
                '\r' => state = State::Cr,
                '\n' => {
                    out.push('\r');
                    state = State::BeginLine;
                }
                _ => {}
            },
            State::Cr => state = if c == '\n' { State::BeginLine } else { State::Line },
            State::Begin | State::BeginLine => unreachable!("handled above"),
        }
        out.push(c);
    }
    out.push_str(match state {
        State::Begin | State::Line => "\r\n.\r\n",
        State::Cr => "\n.\r\n",
        State::BeginLine => ".\r\n",
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_encode_matches_go_dot_writer() {
        assert_eq!(dot_encode(""), "\r\n.\r\n");
        assert_eq!(dot_encode("a\nb"), "a\r\nb\r\n.\r\n");
        assert_eq!(dot_encode("a\r\n"), "a\r\n.\r\n");
        assert_eq!(dot_encode("a\r"), "a\r\n.\r\n");
        assert_eq!(dot_encode(".x\n.y\r\n..z\n"), "..x\r\n..y\r\n...z\r\n.\r\n");
        assert_eq!(dot_encode("a\r.b"), "a\r.b\r\n.\r\n", "no stuffing after a bare CR");
        assert_eq!(dot_encode("a\r\r\n"), "a\r\r\r\n.\r\n");
        assert_eq!(dot_encode("é\n.ü"), "é\r\n..ü\r\n.\r\n");
    }

    #[test]
    fn builds_go_headers() {
        let sender = SmtpEmailSender::new("localhost", "1025", "noreply@example.com", "Growth Tracker");
        let to = vec!["a@example.com".to_string(), "b@example.com".to_string()];
        assert_eq!(
            sender.build_message(&to, "Hi", "<p>x</p>\n"),
            "From: Growth Tracker <noreply@example.com>\r\nTo: a@example.com, b@example.com\r\nSubject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=\"UTF-8\"\r\n\r\n<p>x</p>\n"
        );
    }

    #[tokio::test]
    async fn rejects_header_injection_before_dialing() {
        let sender = SmtpEmailSender::new("127.0.0.1", "1", "noreply@example.com", "GT");
        let err = sender.send(&["a@example.com\r\nRCPT TO:<b@example.com>".into()], "s", "b").await.unwrap_err();
        assert_eq!(err.to_string(), "smtp: A line must not contain CR or LF");
    }
}
