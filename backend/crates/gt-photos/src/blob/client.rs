//! Blob REST client covering the operations the backend uses: Create Container, Put Blob
//! (block blob with a content type) and Delete Blob. Requests are signed with Shared Key (or
//! carry the connection string's SAS) and retried like the Go SDK's default policy.

use std::time::Duration;

use bytes::Bytes;
use chrono::Utc;
use http::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE};
use http::{Method, StatusCode};
use rand::Rng;
use url::Url;

use super::connection::{parse_connection_string, ConnectionStringError};
use super::naming::{go_path_escape, go_query_escape};
use super::shared_key::{InvalidAccountKey, SharedKeyCredential};

/// REST API version sent as `x-ms-version` (the one used by the Go SDK, azblob v1.6.4).
pub const SERVICE_VERSION: &str = "2026-02-06";

const X_MS_DATE: HeaderName = HeaderName::from_static("x-ms-date");
const X_MS_VERSION: HeaderName = HeaderName::from_static("x-ms-version");
const X_MS_BLOB_TYPE: HeaderName = HeaderName::from_static("x-ms-blob-type");
const X_MS_BLOB_CONTENT_TYPE: HeaderName = HeaderName::from_static("x-ms-blob-content-type");
const X_MS_ERROR_CODE: &str = "x-ms-error-code";

/// Why a blob operation failed.
#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error(transparent)]
    ConnectionString(#[from] ConnectionStringError),
    #[error(transparent)]
    AccountKey(#[from] InvalidAccountKey),
    #[error("invalid blob URL {url}: {reason}")]
    InvalidUrl { url: String, reason: String },
    /// The service answered with an unexpected status.
    #[error("{method} {url}: RESPONSE {status}: ERROR CODE: {}", code.as_deref().unwrap_or("UNAVAILABLE"))]
    Status { method: Method, url: String, status: StatusCode, code: Option<String> },
    #[error("{method} {url}: {source}")]
    Transport {
        method: Method,
        url: String,
        #[source]
        source: reqwest::Error,
    },
    /// The caller's deadline passed (Go: `context deadline exceeded`).
    #[error("context deadline exceeded")]
    Timeout,
}

impl BlobError {
    /// The service error code (`x-ms-error-code`, e.g. `ContainerAlreadyExists`).
    pub fn error_code(&self) -> Option<&str> {
        match self {
            BlobError::Status { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    /// HTTP status of a service error.
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            BlobError::Status { status, .. } => Some(*status),
            _ => None,
        }
    }
}

/// Retry behavior (Go azcore defaults: 3 retries, 800 ms exponential backoff with jitter,
/// capped at 60 s, for 408/429/500/502/503/504 and transport errors; `Retry-After` honored).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryOptions {
    pub max_retries: u32,
    pub retry_delay: Duration,
    pub max_retry_delay: Duration,
}

impl Default for RetryOptions {
    fn default() -> Self {
        Self { max_retries: 3, retry_delay: Duration::from_millis(800), max_retry_delay: Duration::from_secs(60) }
    }
}

/// A Blob service client created from a connection string.
#[derive(Debug, Clone)]
pub struct BlobClient {
    http: reqwest::Client,
    /// Service URL without query, ending in `/`.
    service_url: String,
    /// Query parameters of a SAS connection string.
    sas_query: Vec<(String, String)>,
    credential: Option<SharedKeyCredential>,
    retry: RetryOptions,
}

/// One REST call, re-signed on every attempt.
struct Operation<'a> {
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<Bytes>,
    expected: StatusCode,
    name: &'a str,
}

impl BlobClient {
    /// Go: `azblob.NewClientFromConnectionString`. Shared Key auth when the string has an
    /// account name and key, otherwise the SAS token (if any) is appended to every request.
    pub fn from_connection_string(connection_string: &str) -> Result<Self, BlobError> {
        let parsed = parse_connection_string(connection_string)?;
        let credential = if !parsed.account_key.is_empty() && !parsed.account_name.is_empty() {
            Some(SharedKeyCredential::new(&parsed.account_name, &parsed.account_key)?)
        } else {
            None
        };
        let (service_url, sas_query) = match parsed.service_url.split_once('?') {
            Some((base, query)) => (
                base.to_string(),
                url::form_urlencoded::parse(query.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect(),
            ),
            None => (parsed.service_url, Vec::new()),
        };
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .user_agent(concat!("gt-photos/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|source| BlobError::Transport { method: Method::GET, url: service_url.clone(), source })?;
        Ok(Self { http, service_url, sas_query, credential, retry: RetryOptions::default() })
    }

    /// Overrides the retry policy (tests use short delays).
    pub fn with_retry_options(mut self, retry: RetryOptions) -> Self {
        self.retry = retry;
        self
    }

    /// Creates a private container. An existing container is reported as a
    /// [`BlobError::Status`] with code `ContainerAlreadyExists`.
    pub async fn create_container(&self, container: &str) -> Result<(), BlobError> {
        let url = self.url(&self.container_path(container), &[("restype", "container")])?;
        self.execute(Operation {
            method: Method::PUT,
            url,
            headers: HeaderMap::new(),
            body: None,
            expected: StatusCode::CREATED,
            name: "create container",
        })
        .await
    }

    /// Uploads `data` as a block blob in one request, replacing any existing blob, with
    /// `Content-Type: content_type` on the stored blob.
    pub async fn upload(
        &self,
        container: &str,
        blob_name: &str,
        data: Bytes,
        content_type: &str,
    ) -> Result<(), BlobError> {
        let url = self.url(&self.blob_path(container, blob_name), &[])?;
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_LENGTH, HeaderValue::from(data.len()));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
        headers.insert(X_MS_BLOB_TYPE, HeaderValue::from_static("BlockBlob"));
        let blob_content_type = HeaderValue::from_str(content_type).map_err(|e| BlobError::InvalidUrl {
            url: url.to_string(),
            reason: format!("invalid content type: {e}"),
        })?;
        headers.insert(X_MS_BLOB_CONTENT_TYPE, blob_content_type);
        self.execute(Operation {
            method: Method::PUT,
            url,
            headers,
            body: Some(data),
            expected: StatusCode::CREATED,
            name: "upload blob",
        })
        .await
    }

    /// Deletes a blob (a missing blob is a [`BlobError::Status`] 404 `BlobNotFound`).
    pub async fn delete_blob(&self, container: &str, blob_name: &str) -> Result<(), BlobError> {
        let url = self.url(&self.blob_path(container, blob_name), &[])?;
        self.execute(Operation {
            method: Method::DELETE,
            url,
            headers: HeaderMap::new(),
            body: None,
            expected: StatusCode::ACCEPTED,
            name: "delete blob",
        })
        .await
    }

    /// Go `runtime.JoinPaths(serviceURL, container)`.
    fn container_path(&self, container: &str) -> String {
        format!("{}{}", self.service_url, join_segment(container))
    }

    /// Go `runtime.JoinPaths(containerURL, url.PathEscape(blobName))`: the whole name is one
    /// escaped segment (`a/b.jpg` -> `a%2Fb.jpg`).
    fn blob_path(&self, container: &str, blob_name: &str) -> String {
        format!("{}/{}", self.container_path(container), join_segment(&go_path_escape(blob_name)))
    }

    /// Appends the SAS query and operation parameters, sorted by key and encoded like Go's
    /// `url.Values.Encode`.
    fn url(&self, base: &str, params: &[(&str, &str)]) -> Result<Url, BlobError> {
        let mut pairs: Vec<(String, String)> = self.sas_query.clone();
        for (k, v) in params {
            pairs.retain(|(existing, _)| existing != k);
            pairs.push(((*k).to_string(), (*v).to_string()));
        }
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        let query: Vec<String> =
            pairs.iter().map(|(k, v)| format!("{}={}", go_query_escape(k), go_query_escape(v))).collect();
        let raw = if query.is_empty() { base.to_string() } else { format!("{base}?{}", query.join("&")) };
        Url::parse(&raw).map_err(|e| BlobError::InvalidUrl { url: raw.clone(), reason: e.to_string() })
    }

    async fn execute(&self, op: Operation<'_>) -> Result<(), BlobError> {
        let mut retries: u32 = 0;
        loop {
            let (error, retry_after) = match self.attempt(&op).await {
                Ok(()) => return Ok(()),
                Err(Attempt::Fatal(error)) => return Err(error),
                Err(Attempt::Retryable { error, retry_after }) => (error, retry_after),
            };
            if retries >= self.retry.max_retries {
                return Err(error);
            }
            retries += 1;
            let delay = retry_after.unwrap_or_else(|| backoff_delay(&self.retry, retries));
            tracing::warn!(
                operation = op.name,
                retry = retries,
                delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                error = %error,
                "Blob storage request failed, retrying"
            );
            tokio::time::sleep(delay).await;
        }
    }

    async fn attempt(&self, op: &Operation<'_>) -> Result<(), Attempt> {
        let mut headers = op.headers.clone();
        headers.insert(X_MS_DATE, http_date_now());
        headers.insert(X_MS_VERSION, HeaderValue::from_static(SERVICE_VERSION));
        headers.insert(ACCEPT, HeaderValue::from_static("application/xml"));
        if let Some(credential) = &self.credential {
            let auth = credential.authorization(&op.method, &op.url, &headers);
            if let Ok(value) = HeaderValue::from_str(&auth) {
                headers.insert(AUTHORIZATION, value);
            }
        }

        let mut request = self.http.request(op.method.clone(), op.url.clone()).headers(headers);
        if let Some(body) = &op.body {
            request = request.body(body.clone());
        }
        let url = redact_query(&op.url);
        let response = match request.send().await {
            Ok(response) => response,
            Err(source) => {
                let error = BlobError::Transport { method: op.method.clone(), url, source };
                return Err(Attempt::Retryable { error, retry_after: None });
            }
        };

        let status = response.status();
        if status == op.expected {
            return Ok(());
        }
        let retry_after = retry_after(response.headers());
        let header_code = response.headers().get(X_MS_ERROR_CODE).and_then(|v| v.to_str().ok()).map(str::to_string);
        let body = response.text().await.unwrap_or_default();
        let code = header_code.or_else(|| xml_error_code(&body));
        let error = BlobError::Status { method: op.method.clone(), url, status, code };
        if is_retryable_status(status) {
            Err(Attempt::Retryable { error, retry_after })
        } else {
            Err(Attempt::Fatal(error))
        }
    }
}

/// A failed attempt: retried (after `retry_after` when the service asked for it) or final.
enum Attempt {
    Retryable { error: BlobError, retry_after: Option<Duration> },
    Fatal(BlobError),
}

/// Go `path.Join` of a single segment that contains no `/`.
fn join_segment(segment: &str) -> &str {
    if segment.is_empty() {
        "."
    } else {
        segment
    }
}

fn is_retryable_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504)
}

/// `retry-after-ms`, `x-ms-retry-after-ms` (milliseconds) or `Retry-After` (seconds or an
/// HTTP date), in that order of preference.
fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let value = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    for name in ["retry-after-ms", "x-ms-retry-after-ms"] {
        if let Some(ms) = value(name).and_then(|v| v.trim().parse::<u64>().ok()) {
            return Some(Duration::from_millis(ms));
        }
    }
    let raw = value("retry-after")?;
    if let Ok(secs) = raw.trim().parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let at = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    (at.with_timezone(&Utc) - Utc::now()).to_std().ok()
}

/// `(2^attempt - 1) * retry_delay * jitter[0.8, 1.3)`, capped at `max_retry_delay`.
fn backoff_delay(options: &RetryOptions, attempt: u32) -> Duration {
    let factor = 2u32.checked_pow(attempt).map(|f| f - 1).unwrap_or(u32::MAX);
    let base = options.retry_delay.saturating_mul(factor);
    let jitter = rand::thread_rng().gen_range(0.8..1.3);
    base.mul_f64(jitter).min(options.max_retry_delay)
}

fn http_date_now() -> HeaderValue {
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    HeaderValue::from_str(&date).unwrap_or_else(|_| HeaderValue::from_static(""))
}

/// `<Code>...</Code>` from an XML error body.
fn xml_error_code(body: &str) -> Option<String> {
    let start = body.find("<Code>")? + "<Code>".len();
    let end = body[start..].find("</Code>")? + start;
    Some(body[start..end].trim().to_string()).filter(|c| !c.is_empty())
}

/// The URL without its query string (a SAS token is a credential and must not be logged).
fn redact_query(url: &Url) -> String {
    let mut clean = url.clone();
    clean.set_query(None);
    clean.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const AZURITE: &str = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;\
        AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;\
        BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

    #[test]
    fn request_urls_match_go() {
        let client = BlobClient::from_connection_string(AZURITE).unwrap();
        let container = client.url(&client.container_path("profile-pictures"), &[("restype", "container")]).unwrap();
        assert_eq!(container.as_str(), "http://127.0.0.1:10000/devstoreaccount1/profile-pictures?restype=container");
        let blob = client
            .url(&client.blob_path("profile-pictures", "activity-photos/42/2026-01-04/custom:ab$c d;e/uuid.jpg"), &[])
            .unwrap();
        assert_eq!(
            blob.as_str(),
            "http://127.0.0.1:10000/devstoreaccount1/profile-pictures/\
             activity-photos%2F42%2F2026-01-04%2Fcustom:ab$c%20d%3Be%2Fuuid.jpg"
        );
        let traversal = client.url(&client.blob_path("c", "../../x"), &[]).unwrap();
        assert_eq!(traversal.path(), "/devstoreaccount1/c/..%2F..%2Fx", "names never become path segments");
    }

    #[test]
    fn sas_query_is_kept_and_sorted() {
        let client = BlobClient::from_connection_string(
            "BlobEndpoint=https://acct.blob.core.windows.net;SharedAccessSignature=sv=2022&sig=a%2Bb%3D",
        )
        .unwrap();
        assert!(client.credential.is_none());
        let url = client.url(&client.container_path("pics"), &[("restype", "container")]).unwrap();
        assert_eq!(url.as_str(), "https://acct.blob.core.windows.net/pics?restype=container&sig=a%2Bb%3D&sv=2022");
        assert_eq!(redact_query(&url), "https://acct.blob.core.windows.net/pics");
    }

    #[test]
    fn invalid_connection_strings() {
        assert!(matches!(
            BlobClient::from_connection_string("not a connection string"),
            Err(BlobError::ConnectionString(ConnectionStringError::Malformed))
        ));
        assert!(matches!(
            BlobClient::from_connection_string("AccountName=a;AccountKey=@@@"),
            Err(BlobError::AccountKey(_))
        ));
    }

    #[test]
    fn retry_helpers() {
        let mut h = HeaderMap::new();
        h.insert("x-ms-retry-after-ms", HeaderValue::from_static("1"));
        assert_eq!(retry_after(&h), Some(Duration::from_millis(1)));
        h.insert("retry-after-ms", HeaderValue::from_static("5"));
        assert_eq!(retry_after(&h), Some(Duration::from_millis(5)));
        let mut h = HeaderMap::new();
        h.insert("retry-after", HeaderValue::from_static("2"));
        assert_eq!(retry_after(&h), Some(Duration::from_secs(2)));
        assert_eq!(retry_after(&HeaderMap::new()), None);

        let opts = RetryOptions::default();
        let first = backoff_delay(&opts, 1);
        assert!(first >= Duration::from_millis(640) && first < Duration::from_millis(1040), "{first:?}");
        let third = backoff_delay(&opts, 3);
        assert!(third >= Duration::from_millis(4480) && third < Duration::from_millis(7280), "{third:?}");
        assert_eq!(backoff_delay(&opts, 40), opts.max_retry_delay);
        assert!(is_retryable_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(!is_retryable_status(StatusCode::CONFLICT));
    }

    #[test]
    fn error_codes() {
        assert_eq!(
            xml_error_code("<?xml version=\"1.0\"?><Error><Code>ContainerAlreadyExists</Code></Error>").as_deref(),
            Some("ContainerAlreadyExists")
        );
        assert_eq!(xml_error_code("nope"), None);
        let err = BlobError::Status {
            method: Method::PUT,
            url: "http://x/c".into(),
            status: StatusCode::CONFLICT,
            code: Some("ContainerAlreadyExists".into()),
        };
        assert_eq!(err.error_code(), Some("ContainerAlreadyExists"));
        assert!(err.to_string().contains("ContainerAlreadyExists"));
    }
}
