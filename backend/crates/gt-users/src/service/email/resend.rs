//! Resend HTTP API sender (port of `ResendEmailSender`, which used `resend-go` v3.3.0). The
//! request is the one the SDK sends: `POST {base}emails` with a JSON body
//! `{"from","to","subject","html"}`, bearer auth and the SDK's user agent; error messages follow
//! the SDK's `handleError`.

use std::time::Duration;

use async_trait::async_trait;
use gt_core::gojson;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use reqwest::{Response, StatusCode};
use serde::Serialize;
use serde_json::Value;
use url::Url;

use super::{EmailError, EmailSender};

/// The SDK's default API base (overridable with `RESEND_BASE_URL`, as in the SDK).
const DEFAULT_BASE_URL: &str = "https://api.resend.com/";
const SDK_USER_AGENT: &str = "resend-go/3.3.0";
const JSON: &str = "application/json";
/// The SDK's default `http.Client` timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Sends emails through the Resend API (production). `Debug` redacts the API key.
#[derive(Clone)]
pub struct ResendEmailSender {
    client: reqwest::Client,
    api_key: String,
    base_url: Url,
    from_address: String,
    from_name: String,
}

impl std::fmt::Debug for ResendEmailSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResendEmailSender")
            .field("api_key", &"<redacted>")
            .field("base_url", &self.base_url.as_str())
            .field("from_address", &self.from_address)
            .field("from_name", &self.from_name)
            .finish()
    }
}

/// `resend.SendEmailRequest` with only the fields the backend sets (the others are `omitempty`).
#[derive(Serialize)]
struct SendEmailRequest<'a> {
    from: String,
    to: &'a [String],
    subject: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    html: &'a str,
}

impl ResendEmailSender {
    /// A sender for `api_key` (trimmed of spaces and single quotes, like `resend.NewClient`).
    pub fn new(api_key: &str, from_address: &str, from_name: &str) -> Result<Self, EmailError> {
        let base = std::env::var("RESEND_BASE_URL").ok().filter(|v| !v.is_empty());
        let base_url = Url::parse(base.as_deref().unwrap_or(DEFAULT_BASE_URL))
            .or_else(|_| Url::parse(DEFAULT_BASE_URL))
            .map_err(|e| EmailError::new(e.to_string()))?;
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| EmailError::new(format!("failed to build Resend HTTP client: {e}")))?;
        Ok(Self {
            client,
            api_key: api_key.trim().trim_matches('\'').to_string(),
            base_url,
            from_address: from_address.to_string(),
            from_name: from_name.to_string(),
        })
    }

    /// Points the sender at another API base (tests use a local fake).
    pub fn with_base_url(mut self, base_url: Url) -> Self {
        self.base_url = base_url;
        self
    }

    async fn post(&self, body: Vec<u8>) -> Result<Response, EmailError> {
        let url = self.base_url.join("emails").map_err(|e| EmailError::new(e.to_string()))?;
        self.client
            .post(url)
            .header(CONTENT_TYPE, JSON)
            .header(ACCEPT, JSON)
            .header(USER_AGENT, SDK_USER_AGENT)
            .header(AUTHORIZATION, format!("Bearer {}", self.api_key))
            .body(body)
            .send()
            .await
            .map_err(|e| EmailError::new(e.to_string()))
    }
}

#[async_trait]
impl EmailSender for ResendEmailSender {
    async fn send(&self, to: &[String], subject: &str, html_body: &str) -> Result<(), EmailError> {
        let request = SendEmailRequest {
            from: format!("{} <{}>", self.from_name, self.from_address),
            to,
            subject,
            html: html_body,
        };
        // json.NewEncoder(...).Encode appends a newline.
        let mut body = gojson::to_vec(&request).map_err(|e| EmailError::new(e.to_string()))?;
        body.push(b'\n');

        let response = self.post(body).await?;
        let status = response.status();
        if !status.is_success() {
            return Err(error_from_response(response).await);
        }
        if status != StatusCode::NO_CONTENT {
            // The SDK decodes the `{"id": ...}` reply; an empty or invalid body is an error.
            let bytes = response.bytes().await.map_err(|e| EmailError::new(e.to_string()))?;
            let mut values = serde_json::Deserializer::from_slice(&bytes).into_iter::<Value>();
            match values.next() {
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(EmailError::new(e.to_string())),
                None => return Err(EmailError::new("EOF")),
            }
        }
        Ok(())
    }
}

/// Go `resp.Status`, e.g. `422 Unprocessable Entity`.
fn status_text(status: StatusCode) -> String {
    format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or(""))
}

/// The `message` of a JSON error body, `resp.Status` when the body is not JSON or not
/// decodable (SDK `handleError`).
async fn error_message(response: Response) -> (String, reqwest::header::HeaderMap) {
    let status = response.status();
    let headers = response.headers().clone();
    let is_json = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with(JSON));
    if !is_json {
        return (status_text(status), headers);
    }
    let bytes = response.bytes().await.unwrap_or_default();
    let message = match serde_json::Deserializer::from_slice(&bytes).into_iter::<Value>().next() {
        Some(Ok(Value::Object(fields))) => match fields.get("message") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(m)) => m.clone(),
            Some(_) => status_text(status),
        },
        Some(Ok(Value::Null)) => String::new(),
        _ => status_text(status),
    };
    (message, headers)
}

async fn error_from_response(response: Response) -> EmailError {
    let status = response.status();
    let (message, headers) = error_message(response).await;
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    match status {
        StatusCode::TOO_MANY_REQUESTS => EmailError::new(format!(
            "rate limit exceeded: {message} (limit: {}, remaining: {}, reset: {}, retry after: {})",
            header("ratelimit-limit"),
            header("ratelimit-remaining"),
            header("ratelimit-reset"),
            header("retry-after"),
        )),
        StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => EmailError::new(format!("[ERROR]: {message}")),
        _ if message.is_empty() => EmailError::new("[ERROR]: Unknown Error"),
        _ => EmailError::new(format!("[ERROR]: {message}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_body_matches_the_go_sdk() {
        let to = vec!["ada@example.com".to_string()];
        let request = SendEmailRequest {
            from: "Growth Tracker <noreply@example.com>".into(),
            to: &to,
            subject: "Reset Your Password - Growth Tracker",
            html: "<p>Hi & bye</p>",
        };
        assert_eq!(
            gojson::to_string(&request).unwrap(),
            r#"{"from":"Growth Tracker \u003cnoreply@example.com\u003e","to":["ada@example.com"],"subject":"Reset Your Password - Growth Tracker","html":"\u003cp\u003eHi \u0026 bye\u003c/p\u003e"}"#
        );
    }

    #[test]
    fn api_key_is_trimmed_like_new_client() {
        let sender = ResendEmailSender::new(" 're_123' ", "a@b.c", "N").unwrap();
        assert_eq!(sender.api_key, "re_123");
        assert!(!format!("{sender:?}").contains("re_123"), "the key is not logged");
        assert_eq!(sender.base_url.join("emails").unwrap().as_str(), "https://api.resend.com/emails");
    }
}
