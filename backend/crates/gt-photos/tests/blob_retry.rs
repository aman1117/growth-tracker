//! Retry and error handling of `BlobClient` against a local fake Blob endpoint.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::any;
use axum::Router;
use bytes::Bytes;
use gt_photos::blob::{BlobClient, BlobError, RetryOptions};

#[derive(Default)]
struct Fake {
    requests: AtomicUsize,
    /// Number of initial requests answered with 500.
    failures: usize,
    final_status: u16,
    seen_headers: std::sync::Mutex<Vec<HeaderMap>>,
}

async fn handle(State(fake): State<Arc<Fake>>, headers: HeaderMap) -> impl IntoResponse {
    let n = fake.requests.fetch_add(1, Ordering::SeqCst);
    fake.seen_headers.lock().unwrap().push(headers);
    if n < fake.failures {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            [("x-ms-error-code", "InternalError"), ("x-ms-retry-after-ms", "1")],
        )
            .into_response();
    }
    let status = StatusCode::from_u16(fake.final_status).unwrap();
    if status.is_success() {
        status.into_response()
    } else {
        (status, "<?xml version=\"1.0\"?><Error><Code>BlobNotFound</Code></Error>").into_response()
    }
}

async fn serve(fake: Arc<Fake>) -> BlobClient {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().route("/{*path}", any(handle)).with_state(fake);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let conn = format!(
        "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;BlobEndpoint=http://{addr}/devstoreaccount1"
    );
    BlobClient::from_connection_string(&conn).unwrap().with_retry_options(RetryOptions {
        max_retries: 3,
        retry_delay: Duration::from_millis(1),
        max_retry_delay: Duration::from_millis(5),
    })
}

#[tokio::test]
async fn transient_failures_are_retried() {
    let fake = Arc::new(Fake { failures: 2, final_status: 201, ..Fake::default() });
    let client = serve(fake.clone()).await;
    client.upload("c", "1/a.jpg", Bytes::from_static(b"jpeg"), "image/jpeg").await.expect("third try succeeds");
    assert_eq!(fake.requests.load(Ordering::SeqCst), 3);

    let headers = fake.seen_headers.lock().unwrap();
    let last = headers.last().unwrap();
    assert_eq!(last["x-ms-blob-type"], "BlockBlob");
    assert_eq!(last["x-ms-blob-content-type"], "image/jpeg");
    assert_eq!(last["content-type"], "application/octet-stream");
    assert_eq!(last["content-length"], "4");
    assert!(last["authorization"].to_str().unwrap().starts_with("SharedKey devstoreaccount1:"));
}

#[tokio::test]
async fn retries_are_bounded() {
    let fake = Arc::new(Fake { failures: usize::MAX, final_status: 201, ..Fake::default() });
    let client = serve(fake.clone()).await;
    let err = client.upload("c", "1/a.jpg", Bytes::new(), "image/jpeg").await.unwrap_err();
    assert_eq!(err.status(), Some(StatusCode::INTERNAL_SERVER_ERROR));
    assert_eq!(err.error_code(), Some("InternalError"));
    assert_eq!(fake.requests.load(Ordering::SeqCst), 4, "one try plus three retries");
}

#[tokio::test]
async fn client_errors_are_not_retried() {
    let fake = Arc::new(Fake { failures: 0, final_status: 404, ..Fake::default() });
    let client = serve(fake.clone()).await;
    let err = client.delete_blob("c", "1/gone.jpg").await.unwrap_err();
    assert_eq!(err.status(), Some(StatusCode::NOT_FOUND));
    assert_eq!(err.error_code(), Some("BlobNotFound"), "code read from the XML body");
    assert_eq!(fake.requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unexpected_success_status_is_an_error() {
    // Go's generated client accepts only the documented status (202 for Delete Blob).
    let fake = Arc::new(Fake { failures: 0, final_status: 200, ..Fake::default() });
    let client = serve(fake).await;
    assert!(matches!(client.delete_blob("c", "x").await, Err(BlobError::Status { .. })));
}
