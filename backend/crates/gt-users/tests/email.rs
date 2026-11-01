//! Email delivery against local fakes of the Resend API and an SMTP server (ports of
//! `email_test.go`). No external services needed.

use std::sync::{Arc, Mutex};

use gt_core::config::EmailConfig;
use gt_users::service::{
    EmailService, ResendEmailSender, SmtpEmailSender, PASSWORD_RESET_SUBJECT, VERIFICATION_SUBJECT,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

const FRONTEND: &str = "https://app.example.com";

fn email_config(resend_api_key: &str) -> EmailConfig {
    EmailConfig {
        resend_api_key: resend_api_key.into(),
        from_address: "noreply@example.com".into(),
        from_name: "Growth Tracker".into(),
    }
}

// ==================== Resend fake ====================

#[derive(Debug, Clone)]
struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// One canned HTTP response: status line, extra headers and body.
#[derive(Clone)]
struct Reply {
    status: &'static str,
    headers: Vec<(&'static str, &'static str)>,
    body: &'static str,
}

/// Serves the given replies in order (one per connection) and records the requests.
async fn fake_http(replies: Vec<Reply>) -> (url::Url, Arc<Mutex<Vec<HttpRequest>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let log = recorded.clone();
    tokio::spawn(async move {
        for reply in replies {
            let Ok((stream, _)) = listener.accept().await else { return };
            let mut reader = BufReader::new(stream);
            let mut request_line = String::new();
            reader.read_line(&mut request_line).await.unwrap();
            let mut parts = request_line.split_whitespace();
            let (method, path) = (parts.next().unwrap().to_string(), parts.next().unwrap().to_string());
            let mut headers = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                let (k, v) = line.split_once(':').unwrap();
                headers.push((k.trim().to_string(), v.trim().to_string()));
            }
            let len = headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .map(|(_, v)| v.parse::<usize>().unwrap())
                .unwrap_or(0);
            let mut body = vec![0; len];
            reader.read_exact(&mut body).await.unwrap();
            log.lock().unwrap().push(HttpRequest { method, path, headers, body });

            let mut response =
                format!("HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n", reply.status, reply.body.len());
            for (k, v) in &reply.headers {
                response.push_str(&format!("{k}: {v}\r\n"));
            }
            response.push_str("\r\n");
            response.push_str(reply.body);
            let mut stream = reader.into_inner();
            stream.write_all(response.as_bytes()).await.unwrap();
            let _ = stream.shutdown().await;
        }
    });
    (base, recorded)
}

fn json_reply(status: &'static str, body: &'static str) -> Reply {
    Reply { status, headers: vec![("Content-Type", "application/json")], body }
}

async fn resend_service(replies: Vec<Reply>) -> (EmailService, Arc<Mutex<Vec<HttpRequest>>>) {
    let (base, recorded) = fake_http(replies).await;
    let cfg = email_config("re_test_key");
    let sender =
        ResendEmailSender::new(&cfg.resend_api_key, &cfg.from_address, &cfg.from_name).unwrap().with_base_url(base);
    (EmailService::with_sender(Arc::new(sender), &cfg, FRONTEND), recorded)
}

#[tokio::test]
async fn resend_sends_the_sdk_request() {
    let ok = json_reply("200 OK", r#"{"id":"email-123"}"#);
    let (svc, recorded) = resend_service(vec![ok.clone(), ok]).await;

    svc.send_password_reset_email("ada@example.com", "ada", "reset-token").await.unwrap();
    svc.send_verification_email("bob@example.com", "bob", "verify-token").await.unwrap();

    let requests = recorded.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    let reset = &requests[0];
    assert_eq!((reset.method.as_str(), reset.path.as_str()), ("POST", "/emails"));
    assert_eq!(reset.header("authorization"), Some("Bearer re_test_key"));
    assert_eq!(reset.header("user-agent"), Some("resend-go/3.3.0"));
    assert_eq!(reset.header("content-type"), Some("application/json"));
    assert_eq!(reset.header("accept"), Some("application/json"));

    let raw = String::from_utf8(reset.body.clone()).unwrap();
    assert!(raw.starts_with(r#"{"from":"Growth Tracker \u003cnoreply@example.com\u003e","to":["ada@example.com"],"subject":"Reset Your Password - Growth Tracker","html":"\n\u003c!DOCTYPE html\u003e"#), "{raw}");
    assert!(raw.ends_with("}\n"), "json.Encoder appends a newline");
    let body: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(body["subject"], PASSWORD_RESET_SUBJECT);
    assert_eq!(
        body["html"],
        svc.build_password_reset_html("ada", "https://app.example.com/reset-password?token=reset-token")
    );
    let html = body["html"].as_str().unwrap();
    assert!(html.contains("Hi <strong>ada</strong>"));
    assert!(html.contains(r#"width="100%""#));

    let verify: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(verify["to"], serde_json::json!(["bob@example.com"]));
    assert_eq!(verify["subject"], VERIFICATION_SUBJECT);
    let html = verify["html"].as_str().unwrap();
    assert!(html.contains(r#"href="https://app.example.com/verify-email?token=verify-token""#));
    assert!(html.contains(r#"href="https://app.example.com" style="#));
}

#[tokio::test]
async fn resend_errors_match_the_sdk() {
    let replies = vec![
        json_reply(
            "422 Unprocessable Entity",
            r#"{"statusCode":422,"name":"validation_error","message":"Invalid to field"}"#,
        ),
        Reply {
            status: "429 Too Many Requests",
            headers: vec![
                ("Content-Type", "application/json; charset=utf-8"),
                ("ratelimit-limit", "2"),
                ("ratelimit-remaining", "0"),
                ("ratelimit-reset", "1"),
                ("retry-after", "1"),
            ],
            body: r#"{"message":"Too many requests"}"#,
        },
        Reply { status: "500 Internal Server Error", headers: vec![("Content-Type", "text/plain")], body: "boom" },
        json_reply("503 Service Unavailable", r#"{"name":"down"}"#),
        json_reply("200 OK", ""),
    ];
    let (svc, recorded) = resend_service(replies).await;
    let send = || svc.send_password_reset_email("not-an-email", "ada", "token");

    assert_eq!(send().await.unwrap_err().to_string(), "[ERROR]: Invalid to field");
    assert_eq!(
        send().await.unwrap_err().to_string(),
        "rate limit exceeded: Too many requests (limit: 2, remaining: 0, reset: 1, retry after: 1)"
    );
    assert_eq!(send().await.unwrap_err().to_string(), "[ERROR]: 500 Internal Server Error");
    assert_eq!(send().await.unwrap_err().to_string(), "[ERROR]: Unknown Error");
    assert_eq!(send().await.unwrap_err().to_string(), "EOF", "a 200 without a body is an error");
    assert_eq!(recorded.lock().unwrap().len(), 5);
}

// ==================== SMTP fake ====================

#[derive(Debug, Default, Clone)]
struct SmtpSession {
    /// Every byte the client sent.
    transcript: String,
    /// The DATA payload up to (not including) the terminating `.\r\n`.
    data: Option<String>,
}

/// A minimal SMTP server (like Mailpit). `ehlo` is the EHLO reply; `reject_sender` answers MAIL
/// with 550.
async fn fake_smtp(ehlo: &'static str, reject_sender: bool) -> (String, String, Arc<Mutex<Vec<SmtpSession>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let sessions = Arc::new(Mutex::new(Vec::new()));
    let log = sessions.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (read, mut write) = stream.into_split();
            let mut reader = BufReader::new(read);
            let mut session = SmtpSession::default();
            write.write_all(b"220 fake.smtp ESMTP\r\n").await.unwrap();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                    break;
                }
                session.transcript.push_str(&line);
                let upper = line.trim_end().to_ascii_uppercase();
                let reply: String = if upper.starts_with("EHLO") {
                    ehlo.to_string()
                } else if upper.starts_with("MAIL FROM:") && reject_sender {
                    "550 sender rejected\r\n".into()
                } else if upper == "DATA" {
                    write.write_all(b"354 end data with <CR><LF>.<CR><LF>\r\n").await.unwrap();
                    let mut data = String::new();
                    loop {
                        let mut l = String::new();
                        reader.read_line(&mut l).await.unwrap();
                        session.transcript.push_str(&l);
                        if l == ".\r\n" {
                            break;
                        }
                        data.push_str(&l);
                    }
                    session.data = Some(data);
                    "250 OK queued\r\n".into()
                } else if upper == "QUIT" {
                    write.write_all(b"221 bye\r\n").await.unwrap();
                    break;
                } else {
                    "250 OK\r\n".into()
                };
                write.write_all(reply.as_bytes()).await.unwrap();
            }
            log.lock().unwrap().push(session);
        }
    });
    (addr.ip().to_string(), addr.port().to_string(), sessions)
}

async fn wait_for_sessions(sessions: &Arc<Mutex<Vec<SmtpSession>>>, n: usize) -> Vec<SmtpSession> {
    for _ in 0..200 {
        if sessions.lock().unwrap().len() >= n {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    sessions.lock().unwrap().clone()
}

#[tokio::test]
async fn smtp_session_matches_go_net_smtp() {
    let (host, port, sessions) =
        fake_smtp("250-fake.smtp\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 SIZE 1000000\r\n", false).await;
    let cfg = email_config("");
    let sender = SmtpEmailSender::new(&host, &port, &cfg.from_address, &cfg.from_name);
    let svc = EmailService::with_sender(Arc::new(sender), &cfg, FRONTEND);

    svc.send_verification_email("ada@example.com", "ada", "verify-token").await.unwrap();

    let sessions = wait_for_sessions(&sessions, 1).await;
    assert_eq!(sessions.len(), 1);
    let html = svc.build_verification_email_html("ada", "https://app.example.com/verify-email?token=verify-token");
    let data = format!(
        "From: Growth Tracker <noreply@example.com>\r\nTo: ada@example.com\r\nSubject: Verify Your Email - Growth Tracker\r\n\
         MIME-Version: 1.0\r\nContent-Type: text/html; charset=\"UTF-8\"\r\n\r\n{}",
        html.replace('\n', "\r\n")
    );
    assert_eq!(sessions[0].data.as_deref(), Some(data.as_str()));
    assert_eq!(
        sessions[0].transcript,
        format!(
            "EHLO localhost\r\nMAIL FROM:<noreply@example.com> BODY=8BITMIME SMTPUTF8\r\nRCPT TO:<ada@example.com>\r\nDATA\r\n{data}.\r\nQUIT\r\n"
        ),
        "byte-identical to Go's smtp.SendMail session"
    );
}

#[tokio::test]
async fn smtp_failures_are_returned() {
    let (host, port, sessions) = fake_smtp("250 fake.smtp\r\n", true).await;
    let cfg = email_config("");
    let svc = EmailService::with_sender(
        Arc::new(SmtpEmailSender::new(&host, &port, &cfg.from_address, &cfg.from_name)),
        &cfg,
        FRONTEND,
    );

    let err = svc.send_password_reset_email("ada@example.com", "ada", "token").await.unwrap_err();
    assert!(err.to_string().contains("sender rejected"), "{err}");
    let sessions = wait_for_sessions(&sessions, 1).await;
    assert!(sessions.iter().all(|s| s.data.is_none()), "nothing was delivered");
    assert!(sessions[0].transcript.starts_with("EHLO localhost\r\nMAIL FROM:<noreply@example.com>\r\n"));

    // Nothing listening.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = closed.local_addr().unwrap().port().to_string();
    drop(closed);
    let svc =
        EmailService::with_sender(Arc::new(SmtpEmailSender::new("127.0.0.1", &port, "a@b.c", "N")), &cfg, FRONTEND);
    assert!(svc.send_verification_email("ada@example.com", "ada", "t").await.is_err());
}

/// The only test that touches `SMTP_HOST`/`SMTP_PORT`/`RESEND_*` (process-wide).
#[tokio::test]
async fn new_selects_resend_or_smtp_from_the_environment() {
    let (host, port, sessions) = fake_smtp("250 fake.smtp\r\n", false).await;
    std::env::set_var("SMTP_HOST", &host);
    std::env::set_var("SMTP_PORT", &port);
    let svc = EmailService::new(&email_config(""), FRONTEND).unwrap();
    let debug = format!("{:?}", svc.sender());
    assert!(debug.contains("SmtpEmailSender") && debug.contains(&format!("port: {port:?}")), "{debug}");
    svc.send_verification_email("ada@example.com", "ada", "verify-token").await.unwrap();
    let sessions = wait_for_sessions(&sessions, 1).await;
    let data = sessions[0].data.clone().unwrap();
    assert!(data.contains("To: ada@example.com\r\n"));
    assert!(data.contains("https://app.example.com/verify-email?token=verify-token"));

    std::env::remove_var("SMTP_HOST");
    std::env::remove_var("SMTP_PORT");
    let svc = EmailService::new(&email_config(""), FRONTEND).unwrap();
    let debug = format!("{:?}", svc.sender());
    assert!(debug.contains(r#"host: "localhost""#) && debug.contains(r#"port: "1025""#), "Mailpit defaults: {debug}");
    assert_eq!(
        (svc.from_address(), svc.from_name(), svc.frontend_url()),
        ("noreply@example.com", "Growth Tracker", FRONTEND)
    );

    let svc = EmailService::new(&email_config("re_key"), FRONTEND).unwrap();
    assert!(format!("{:?}", svc.sender()).contains("ResendEmailSender"), "an API key selects Resend");
}
