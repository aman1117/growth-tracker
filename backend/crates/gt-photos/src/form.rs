//! Form parsing with Fiber (fasthttp) semantics, for the upload handlers:
//!
//! * [`FormRequest::value`] is `c.FormValue(key)`: the query string first, then an
//!   `application/x-www-form-urlencoded` body, then the multipart form's first value;
//! * [`FormRequest::file`] is `c.FormFile(key)`: the first file part named `key`.
//!
//! Like Fiber's default `BodyLimit`, bodies over 4 MiB are answered with
//! `413 Request Entity Too Large` (plain text) before the form is looked at.

use std::collections::HashMap;
use std::convert::Infallible;

use axum::body::to_bytes;
use axum::extract::{FromRequest, Request};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use gt_core::extract::QueryParams;
use gt_core::response;

use crate::validation::go_base;

/// Fiber's default `BodyLimit` (4 MiB).
pub const FIBER_BODY_LIMIT: usize = 4 * 1024 * 1024;

const MULTIPART_FORM_DATA: &str = "multipart/form-data";
const FORM_URLENCODED: &str = "application/x-www-form-urlencoded";

/// An uploaded file part (Go `multipart.FileHeader` with its content in memory).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadedFile {
    /// The client's file name reduced to its last path element (Go `filepath.Base`).
    pub filename: String,
    /// The part's `Content-Type` header, `""` when absent.
    pub content_type: String,
    /// Size in bytes.
    pub size: i64,
    pub data: Bytes,
}

/// Why `c.FormFile` found no file (only logged by the handlers, which all answer
/// `No image file provided`). Messages are fasthttp's.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FormError {
    #[error("request Content-Type has bad boundary or is not multipart/form-data")]
    NotMultipart,
    #[error("malformed multipart form: {0}")]
    Malformed(String),
    #[error("there is no uploaded file associated with the given key")]
    MissingFile,
}

/// A parsed `multipart/form-data` body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MultipartForm {
    values: HashMap<String, Vec<String>>,
    files: HashMap<String, Vec<UploadedFile>>,
}

impl MultipartForm {
    /// All values of a non-file field.
    pub fn values(&self, key: &str) -> &[String] {
        self.values.get(key).map(Vec::as_slice).unwrap_or(&[])
    }

    /// All files of a field.
    pub fn files(&self, key: &str) -> &[UploadedFile] {
        self.files.get(key).map(Vec::as_slice).unwrap_or(&[])
    }
}

/// The form data of a request (query string + body).
#[derive(Debug, Clone)]
pub struct FormRequest {
    query: QueryParams,
    post_args: Vec<(String, String)>,
    multipart: Result<MultipartForm, FormError>,
}

impl FormRequest {
    /// Parses `body` according to the request's `Content-Type`.
    pub async fn parse(headers: &HeaderMap, query: Option<&str>, body: Bytes) -> Self {
        let content_type = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
        let post_args = if content_type.starts_with(FORM_URLENCODED) {
            url::form_urlencoded::parse(&body).map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
        } else {
            Vec::new()
        };
        let multipart = match multipart_boundary(content_type).filter(|b| !b.is_empty()) {
            Some(boundary) => parse_multipart(boundary, body).await,
            None => Err(FormError::NotMultipart),
        };
        Self { query: QueryParams::parse(query), post_args, multipart }
    }

    /// Go `c.FormValue(key)`; `""` when absent.
    pub fn value(&self, key: &str) -> &str {
        let query = self.query.get(key);
        if !query.is_empty() {
            return query;
        }
        if let Some((_, v)) = self.post_args.iter().find(|(k, _)| k == key) {
            if !v.is_empty() {
                return v;
            }
        }
        match &self.multipart {
            Ok(form) => form.values(key).first().map(String::as_str).unwrap_or(""),
            Err(_) => "",
        }
    }

    /// Go `c.FormFile(key)`.
    pub fn file(&self, key: &str) -> Result<&UploadedFile, FormError> {
        match &self.multipart {
            Ok(form) => form.files(key).first().ok_or(FormError::MissingFile),
            Err(err) => Err(err.clone()),
        }
    }

    /// The parsed multipart form, or why there is none.
    pub fn multipart(&self) -> Result<&MultipartForm, &FormError> {
        self.multipart.as_ref()
    }
}

impl<S: Send + Sync> FromRequest<S> for FormRequest {
    /// `413 Request Entity Too Large` (or `400 Bad Request` when the body cannot be read),
    /// as Fiber's server error handler answers before routing.
    type Rejection = Response;

    async fn from_request(req: Request, _state: &S) -> Result<Self, Self::Rejection> {
        let (parts, body) = req.into_parts();
        let declared = parts
            .headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        if declared.is_some_and(|len| len > FIBER_BODY_LIMIT as u64) {
            return Err(entity_too_large());
        }
        let bytes = match to_bytes(body, FIBER_BODY_LIMIT).await {
            Ok(bytes) => bytes,
            Err(err) => {
                let too_large = err.into_inner().downcast_ref::<http_body_util::LengthLimitError>().is_some();
                return Err(if too_large { entity_too_large() } else { response::status(StatusCode::BAD_REQUEST) });
            }
        };
        Ok(Self::parse(&parts.headers, parts.uri.query(), bytes).await)
    }
}

/// Fiber's 413 answer (`text/plain`, status text body).
pub fn entity_too_large() -> Response {
    response::text(StatusCode::PAYLOAD_TOO_LARGE, "Request Entity Too Large")
}

/// fasthttp `MultipartFormBoundary`: the `Content-Type` must start with
/// `multipart/form-data;` (case-sensitive) and carry a `boundary=` parameter (optionally
/// quoted).
pub fn multipart_boundary(content_type: &str) -> Option<&str> {
    let mut rest = content_type.strip_prefix(MULTIPART_FORM_DATA)?;
    if !rest.starts_with(';') {
        return None;
    }
    loop {
        rest = rest[1..].trim_start_matches(' ');
        if let Some(value) = rest.strip_prefix("boundary") {
            let value = value.strip_prefix('=')?;
            let value = value.split(';').next().unwrap_or("");
            let unquoted = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).filter(|_| value.len() > 1);
            return Some(unquoted.unwrap_or(value));
        }
        let next = rest.find(';')?;
        rest = &rest[next..];
    }
}

/// Go `multipart.Reader.ReadForm`: parts without a form name are skipped, parts with a
/// (non-empty) file name are files, everything else is a value.
async fn parse_multipart(boundary: &str, body: Bytes) -> Result<MultipartForm, FormError> {
    let stream = futures::stream::once(async move { Ok::<Bytes, Infallible>(body) });
    let mut multipart = multer::Multipart::new(stream, boundary);
    let mut form = MultipartForm::default();
    let malformed = |e: multer::Error| FormError::Malformed(e.to_string());
    while let Some(field) = multipart.next_field().await.map_err(malformed)? {
        let Some(name) = field.name().filter(|n| !n.is_empty()).map(str::to_string) else {
            continue;
        };
        let filename = field.file_name().filter(|f| !f.is_empty()).map(go_base);
        let content_type =
            field.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let data = field.bytes().await.map_err(malformed)?;
        match filename {
            Some(filename) => {
                let size = i64::try_from(data.len()).unwrap_or(i64::MAX);
                form.files.entry(name).or_default().push(UploadedFile { filename, content_type, size, data });
            }
            None => form.values.entry(name).or_default().push(String::from_utf8_lossy(&data).into_owned()),
        }
    }
    Ok(form)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::HeaderValue;

    const BOUNDARY: &str = "XyZ";

    fn multipart_body(parts: &[(&str, Option<&str>, &[u8])]) -> Vec<u8> {
        let mut body = Vec::new();
        for (name, filename, data) in parts {
            body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
            match filename {
                Some(f) => body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{f}\"\r\nContent-Type: image/png\r\n\r\n"
                    )
                    .as_bytes(),
                ),
                None => body
                    .extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes()),
            }
            body.extend_from_slice(data);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
        body
    }

    fn headers(content_type: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_str(content_type).unwrap());
        h
    }

    #[test]
    fn boundary_parsing_matches_fasthttp() {
        assert_eq!(multipart_boundary("multipart/form-data; boundary=abc"), Some("abc"));
        assert_eq!(multipart_boundary("multipart/form-data;boundary=\"a b\""), Some("a b"));
        assert_eq!(multipart_boundary("multipart/form-data; charset=utf-8; boundary=x; foo=bar"), Some("x"));
        assert_eq!(multipart_boundary("multipart/form-data"), None);
        assert_eq!(multipart_boundary("multipart/form-data; charset=utf-8"), None);
        assert_eq!(multipart_boundary("Multipart/Form-Data; boundary=abc"), None, "prefix is case-sensitive");
        assert_eq!(multipart_boundary("application/json"), None);
    }

    #[tokio::test]
    async fn files_and_values() {
        let body = multipart_body(&[
            ("activity_name", None, b"study"),
            ("image", Some("C:/photos/../Me.PNG"), b"\x89PNG data"),
            ("image", Some("second.jpg"), b"x"),
            ("empty_name", Some(""), b"treated as a value"),
        ]);
        let form = FormRequest::parse(
            &headers(&format!("multipart/form-data; boundary={BOUNDARY}")),
            Some("photo_date="),
            body.into(),
        )
        .await;
        assert_eq!(form.value("activity_name"), "study");
        assert_eq!(form.value("empty_name"), "treated as a value");
        assert_eq!(form.value("photo_date"), "", "empty query values fall through");
        let file = form.file("image").unwrap();
        assert_eq!(file.filename, "Me.PNG");
        assert_eq!(file.content_type, "image/png");
        assert_eq!(file.size, 9);
        assert_eq!(&file.data[..], b"\x89PNG data");
        assert_eq!(form.file("other"), Err(FormError::MissingFile));
    }

    #[tokio::test]
    async fn query_wins_and_urlencoded_bodies() {
        let body = multipart_body(&[("activity_name", None, b"from-body")]);
        let form = FormRequest::parse(
            &headers(&format!("multipart/form-data; boundary={BOUNDARY}")),
            Some("activity_name=from+query"),
            body.into(),
        )
        .await;
        assert_eq!(form.value("activity_name"), "from query");

        let form = FormRequest::parse(
            &headers("application/x-www-form-urlencoded"),
            None,
            Bytes::from_static(b"activity_name=a&photo_date=2026-01-04"),
        )
        .await;
        assert_eq!(form.value("photo_date"), "2026-01-04");
        assert_eq!(form.file("image"), Err(FormError::NotMultipart));
    }

    #[tokio::test]
    async fn malformed_and_non_multipart_bodies() {
        let form =
            FormRequest::parse(&headers("application/json"), None, Bytes::from_static(b"{\"image\":\"x\"}")).await;
        assert_eq!(form.file("image"), Err(FormError::NotMultipart));
        assert_eq!(form.value("image"), "");

        let form = FormRequest::parse(
            &headers(&format!("multipart/form-data; boundary={BOUNDARY}")),
            None,
            Bytes::from_static(b"--XyZ\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nunterminated"),
        )
        .await;
        assert!(matches!(form.file("image"), Err(FormError::Malformed(_))));
        assert_eq!(form.value("a"), "");
    }

    #[tokio::test]
    async fn bodies_over_the_fiber_limit_are_rejected() {
        let req = Request::builder()
            .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
            .header(header::CONTENT_LENGTH, (FIBER_BODY_LIMIT + 1).to_string())
            .body(Body::from(vec![0u8; FIBER_BODY_LIMIT + 1]))
            .unwrap();
        let resp = FormRequest::from_request(req, &()).await.unwrap_err();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"Request Entity Too Large");

        let stream = futures::stream::iter(vec![Ok::<_, Infallible>(Bytes::from(vec![0u8; FIBER_BODY_LIMIT + 1]))]);
        let req = Request::builder().body(Body::from_stream(stream)).unwrap();
        let resp = FormRequest::from_request(req, &()).await.unwrap_err();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE, "chunked bodies too");

        let ok = Request::builder().uri("/x?k=v").body(Body::from(vec![0u8; FIBER_BODY_LIMIT])).unwrap();
        let form = FormRequest::from_request(ok, &()).await.unwrap();
        assert_eq!(form.value("k"), "v");
    }
}
