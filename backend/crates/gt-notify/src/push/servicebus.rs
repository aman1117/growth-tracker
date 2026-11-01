//! Azure Service Bus over its REST API: connection strings, SAS tokens, sending and peek-lock
//! receiving. The Go services use the AMQP SDK; the REST API reaches the same queue, and a
//! message body sent through either protocol is received unchanged through the other.

use std::time::Duration;

use base64::Engine;
use hmac::{Hmac, Mac};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, LOCATION};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Lifetime of the SAS tokens signed for each request.
const SAS_TOKEN_TTL: Duration = Duration::from_secs(3600);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Go SDK client retry options used by the publisher: 3 retries, 1 s doubling up to 30 s.
const MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);

/// Service Bus failures.
#[derive(Debug, thiserror::Error)]
pub enum ServiceBusError {
    /// The connection string cannot be used (messages follow the Go SDK's).
    #[error("{0}")]
    ConnectionString(String),
    #[error("service bus request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("service bus returned {status}: {body}")]
    Status { status: u16, body: String },
    #[error("invalid service bus response: {0}")]
    InvalidResponse(String),
}

impl ServiceBusError {
    fn is_transient(&self) -> bool {
        match self {
            Self::Http(err) => !err.is_builder(),
            Self::Status { status, .. } => *status == 408 || *status == 429 || *status >= 500,
            _ => false,
        }
    }
}

/// The parts of a Service Bus connection string
/// (`Endpoint=sb://<ns>.servicebus.windows.net/;SharedAccessKeyName=..;SharedAccessKey=..`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionString {
    /// Fully qualified namespace, e.g. `ns.servicebus.windows.net`.
    pub namespace: String,
    pub key_name: Option<String>,
    pub key: Option<String>,
    /// A pre-signed `SharedAccessSignature sr=...` token.
    pub signature: Option<String>,
    pub entity_path: Option<String>,
}

impl ConnectionString {
    /// Parses a connection string with the Go SDK's rules: `;`-separated `key=value` pairs, keys
    /// case-insensitive, unknown keys ignored.
    pub fn parse(conn: &str) -> Result<Self, ServiceBusError> {
        let mut namespace = String::new();
        let (mut key_name, mut key, mut signature, mut entity_path) = (None, None, None, None);
        for pair in conn.split(';').filter(|p| !p.is_empty()) {
            let Some((name, value)) = pair.split_once('=') else {
                return Err(ServiceBusError::ConnectionString(
                    "failed parsing connection string due to unmatched key value separated by '='".into(),
                ));
            };
            let value = value.to_string();
            if name.eq_ignore_ascii_case("Endpoint") {
                namespace = endpoint_host(&value);
            } else if name.eq_ignore_ascii_case("SharedAccessKeyName") {
                key_name = Some(value);
            } else if name.eq_ignore_ascii_case("SharedAccessKey") {
                key = Some(value);
            } else if name.eq_ignore_ascii_case("SharedAccessSignature") {
                signature = Some(value);
            } else if name.eq_ignore_ascii_case("EntityPath") {
                entity_path = Some(value);
            }
        }
        if namespace.is_empty() {
            return Err(ServiceBusError::ConnectionString(r#"key "Endpoint" must not be empty"#.into()));
        }
        if signature.is_none() && key_name.is_none() {
            return Err(ServiceBusError::ConnectionString(r#"key "SharedAccessKeyName" must not be empty"#.into()));
        }
        if signature.is_none() && key.is_none() {
            return Err(ServiceBusError::ConnectionString(
                r#"key "SharedAccessKey" or "SharedAccessSignature" cannot both be empty"#.into(),
            ));
        }
        Ok(Self { namespace, key_name, key, signature, entity_path })
    }
}

/// The host of an `sb://host/` endpoint (Go `url.Parse(value).Host`).
fn endpoint_host(endpoint: &str) -> String {
    let rest = endpoint.split_once("://").map_or("", |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    authority.rsplit_once('@').map_or(authority, |(_, host)| host).to_string()
}

/// Go `url.QueryEscape`.
pub fn query_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A Service Bus SAS token for `resource_uri` valid until `expiry_unix`, signed exactly like the
/// Go SDK: the audience is the lower-cased, query-escaped URI and the signature is the base64
/// HMAC-SHA256 of `audience + "\n" + expiry` keyed with the shared access key's UTF-8 bytes.
pub fn sas_token(resource_uri: &str, key_name: &str, key: &str, expiry_unix: i64) -> String {
    let audience = query_escape(resource_uri).to_lowercase();
    // HMAC accepts keys of any length, so this cannot fail.
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts keys of any length");
    mac.update(format!("{audience}\n{expiry_unix}").as_bytes());
    let signature = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    format!("SharedAccessSignature sr={audience}&sig={}&se={expiry_unix}&skn={key_name}", query_escape(&signature))
}

/// An application property value (Go `ApplicationProperties` entries).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropertyValue {
    UInt(u64),
    Text(String),
}

impl PropertyValue {
    /// REST custom-property header value: numbers bare, strings JSON-quoted.
    fn header_value(&self) -> Option<HeaderValue> {
        match self {
            Self::UInt(n) => Some(HeaderValue::from(*n)),
            Self::Text(s) => serde_json::to_string(s).ok().and_then(|q| HeaderValue::from_str(&q).ok()),
        }
    }
}

/// A message to send (the fields the Go publisher sets on `azservicebus.Message`).
#[derive(Debug, Clone, PartialEq)]
pub struct OutgoingMessage {
    pub body: Vec<u8>,
    pub message_id: String,
    /// Go `Subject` (REST `Label`).
    pub subject: String,
    pub time_to_live: Option<Duration>,
    pub application_properties: Vec<(String, PropertyValue)>,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct OutgoingBrokerProperties<'a> {
    message_id: &'a str,
    label: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    time_to_live: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
struct IncomingBrokerProperties {
    delivery_count: u32,
    lock_token: String,
    message_id: String,
    sequence_number: i64,
    label: Option<String>,
}

/// A message received in peek-lock mode; settle it with [`ServiceBusClient::complete`] or
/// [`ServiceBusClient::abandon`] before the lock expires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedMessage {
    pub body: Vec<u8>,
    pub message_id: String,
    /// Number of deliveries including this one (the first delivery is 1, like the Go SDK's
    /// `ReceivedMessage.DeliveryCount`).
    pub delivery_count: u32,
    pub sequence_number: i64,
    pub lock_token: String,
    pub subject: Option<String>,
    /// URI of the locked message, used to settle it.
    pub location: String,
}

#[derive(Debug, Clone)]
enum Credential {
    Key { name: String, key: String },
    Signature(String),
}

/// A REST client for one queue.
#[derive(Debug, Clone)]
pub struct ServiceBusClient {
    http: reqwest::Client,
    namespace: String,
    queue: String,
    credential: Credential,
}

impl ServiceBusClient {
    /// A client for `queue` in the namespace of the connection string.
    pub fn from_connection_string(conn: &str, queue: &str) -> Result<Self, ServiceBusError> {
        let parsed = ConnectionString::parse(conn)?;
        let credential = match (parsed.signature, parsed.key_name, parsed.key) {
            (Some(signature), _, _) => Credential::Signature(signature),
            (None, Some(name), Some(key)) => Credential::Key { name, key },
            _ => return Err(ServiceBusError::ConnectionString("missing shared access key".into())),
        };
        let http = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).build()?;
        Ok(Self { http, namespace: parsed.namespace, queue: queue.to_string(), credential })
    }

    /// The namespace host the client talks to.
    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    /// The queue the client sends to and receives from.
    pub fn queue(&self) -> &str {
        &self.queue
    }

    fn entity_url(&self) -> String {
        format!("https://{}/{}", self.namespace, self.queue)
    }

    fn authorization(&self) -> String {
        match &self.credential {
            Credential::Signature(signature) => signature.clone(),
            Credential::Key { name, key } => {
                let expiry = chrono::Utc::now().timestamp() + SAS_TOKEN_TTL.as_secs() as i64;
                sas_token(&self.entity_url(), name, key, expiry)
            }
        }
    }

    /// Sends one message, retrying transient failures like the Go SDK (3 retries, 1 s doubling).
    pub async fn send(&self, message: &OutgoingMessage) -> Result<(), ServiceBusError> {
        let mut delay = RETRY_DELAY;
        let mut attempt = 0;
        loop {
            match self.send_once(message).await {
                Ok(()) => return Ok(()),
                Err(err) if attempt < MAX_RETRIES && err.is_transient() => {
                    attempt += 1;
                    tracing::debug!(attempt, error = %err, "Retrying Service Bus send");
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(MAX_RETRY_DELAY);
                }
                Err(err) => return Err(err),
            }
        }
    }

    async fn send_once(&self, message: &OutgoingMessage) -> Result<(), ServiceBusError> {
        let broker = OutgoingBrokerProperties {
            message_id: &message.message_id,
            label: &message.subject,
            // Whole seconds: the Go publisher's TTL is `ttlSeconds * time.Second`.
            time_to_live: message.time_to_live.map(|ttl| ttl.as_secs()),
        };
        let broker = serde_json::to_string(&broker).map_err(|e| ServiceBusError::InvalidResponse(e.to_string()))?;
        let mut headers = HeaderMap::new();
        for (name, value) in &message.application_properties {
            match (HeaderName::try_from(name.as_str()), value.header_value()) {
                (Ok(name), Some(value)) => {
                    headers.insert(name, value);
                }
                _ => tracing::debug!(property = %name, "Skipping application property that is not a valid header"),
            }
        }
        let response = self
            .http
            .post(format!("{}/messages", self.entity_url()))
            .timeout(REQUEST_TIMEOUT)
            .header(AUTHORIZATION, self.authorization())
            .header("BrokerProperties", broker)
            .headers(headers)
            .body(message.body.clone())
            .send()
            .await?;
        expect_status(response, &[201]).await
    }

    /// Locks and returns the next message, waiting up to `wait` for one (`None` when the queue
    /// stayed empty).
    pub async fn receive(&self, wait: Duration) -> Result<Option<ReceivedMessage>, ServiceBusError> {
        let response = self
            .http
            .post(format!("{}/messages/head?timeout={}", self.entity_url(), wait.as_secs()))
            .timeout(wait + REQUEST_TIMEOUT)
            .header(AUTHORIZATION, self.authorization())
            .header(reqwest::header::CONTENT_LENGTH, 0)
            .send()
            .await?;
        let status = response.status().as_u16();
        if status == 204 {
            return Ok(None);
        }
        if status != 201 {
            let body = response.text().await.unwrap_or_default();
            return Err(ServiceBusError::Status { status, body });
        }
        let header =
            |name| response.headers().get(name).and_then(|v: &HeaderValue| v.to_str().ok()).map(str::to_string);
        let broker: IncomingBrokerProperties = header("BrokerProperties")
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|e| ServiceBusError::InvalidResponse(format!("BrokerProperties: {e}")))?
            .unwrap_or_default();
        let location = header(LOCATION.as_str()).unwrap_or_else(|| {
            format!("{}/messages/{}/{}", self.entity_url(), broker.sequence_number, broker.lock_token)
        });
        let body = response.bytes().await?.to_vec();
        Ok(Some(ReceivedMessage {
            body,
            message_id: broker.message_id,
            delivery_count: broker.delivery_count,
            sequence_number: broker.sequence_number,
            lock_token: broker.lock_token,
            subject: broker.label,
            location,
        }))
    }

    /// Settles a message as processed (removes it from the queue).
    pub async fn complete(&self, message: &ReceivedMessage) -> Result<(), ServiceBusError> {
        let response = self
            .http
            .delete(&message.location)
            .timeout(REQUEST_TIMEOUT)
            .header(AUTHORIZATION, self.authorization())
            .send()
            .await?;
        expect_status(response, &[200]).await
    }

    /// Releases the lock so the message is delivered again (its delivery count increases).
    pub async fn abandon(&self, message: &ReceivedMessage) -> Result<(), ServiceBusError> {
        let response = self
            .http
            .put(&message.location)
            .timeout(REQUEST_TIMEOUT)
            .header(AUTHORIZATION, self.authorization())
            .header(reqwest::header::CONTENT_LENGTH, 0)
            .send()
            .await?;
        expect_status(response, &[200]).await
    }

    /// Opens the HTTPS connection (TLS handshake) ahead of the first message. Any HTTP answer
    /// counts as success.
    pub async fn warmup(&self) -> Result<(), ServiceBusError> {
        self.http
            .get(self.entity_url())
            .timeout(REQUEST_TIMEOUT)
            .header(AUTHORIZATION, self.authorization())
            .send()
            .await?;
        Ok(())
    }
}

async fn expect_status(response: reqwest::Response, ok: &[u16]) -> Result<(), ServiceBusError> {
    let status = response.status().as_u16();
    if ok.contains(&status) {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    Err(ServiceBusError::Status { status, body: body.chars().take(500).collect() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_connection_strings_like_the_go_sdk() {
        let c = ConnectionString::parse(
            "Endpoint=sb://my-ns.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=abc+/def==",
        )
        .unwrap();
        assert_eq!(c.namespace, "my-ns.servicebus.windows.net");
        assert_eq!(c.key_name.as_deref(), Some("RootManageSharedAccessKey"));
        assert_eq!(c.key.as_deref(), Some("abc+/def=="), "values may contain '='");

        let lower =
            ConnectionString::parse("endpoint=sb://ns.example/;sharedaccesskeyname=n;sharedaccesskey=k;EntityPath=q")
                .unwrap();
        assert_eq!(lower.namespace, "ns.example");
        assert_eq!(lower.entity_path.as_deref(), Some("q"));

        let err = ConnectionString::parse("not-a-connection-string").unwrap_err();
        assert!(err.to_string().contains("unmatched key value"), "{err}");
        assert!(ConnectionString::parse("SharedAccessKeyName=n;SharedAccessKey=k").is_err());
        assert!(ConnectionString::parse("Endpoint=sb://ns/;SharedAccessKey=k").is_err());
        assert!(ConnectionString::parse("Endpoint=sb://ns/;SharedAccessKeyName=n").is_err());
        assert!(ConnectionString::parse("Endpoint=sb://ns/;SharedAccessSignature=SharedAccessSignature sr=x").is_ok());
    }

    #[test]
    fn query_escape_matches_go() {
        assert_eq!(query_escape("https://ns.servicebus.windows.net/q"), "https%3A%2F%2Fns.servicebus.windows.net%2Fq");
        assert_eq!(query_escape("a b+c/=~_.-"), "a+b%2Bc%2F%3D~_.-");
    }

    #[test]
    fn sas_tokens_are_signed_like_the_go_sdk() {
        // Reference computed with Python: hmac.new(b"secret-key", b"https%3a%2f%2fns.servicebus.windows.net%2fpush-notifications\n1700000000", sha256)
        let token =
            sas_token("https://ns.servicebus.windows.net/push-notifications", "send", "secret-key", 1_700_000_000);
        assert_eq!(token, EXPECTED_SAS);
    }

    const EXPECTED_SAS: &str = "SharedAccessSignature sr=https%3a%2f%2fns.servicebus.windows.net%2fpush-notifications&sig=HsQdhtGhf9%2Bgiu8i67I0y7Eup8aPCdtRX3uzEJ8ggrU%3D&se=1700000000&skn=send";

    #[test]
    fn property_header_values() {
        assert_eq!(PropertyValue::UInt(42).header_value().unwrap(), "42");
        assert_eq!(PropertyValue::Text("like:1:2026-01-02".into()).header_value().unwrap(), "\"like:1:2026-01-02\"");
    }

    #[test]
    fn outgoing_broker_properties() {
        let props =
            OutgoingBrokerProperties { message_id: "push-1-2", label: "like_received", time_to_live: Some(3600) };
        assert_eq!(
            serde_json::to_string(&props).unwrap(),
            r#"{"MessageId":"push-1-2","Label":"like_received","TimeToLive":3600}"#
        );
        let incoming: IncomingBrokerProperties = serde_json::from_str(
            r#"{"DeliveryCount":2,"EnqueuedSequenceNumber":0,"EnqueuedTimeUtc":"Wed, 02 Jul 2014 01:32:27 GMT","Label":"M1","LockToken":"7da9","LockedUntilUtc":"Wed, 02 Jul 2014 01:33:27 GMT","MessageId":"31907","SequenceNumber":2,"State":"Active","TimeToLive":10}"#,
        )
        .unwrap();
        assert_eq!(incoming.delivery_count, 2);
        assert_eq!(incoming.lock_token, "7da9");
        assert_eq!(incoming.sequence_number, 2);
        assert_eq!(incoming.label.as_deref(), Some("M1"));
    }
}
