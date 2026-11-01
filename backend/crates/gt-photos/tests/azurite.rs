//! `BlobClient` / `BlobStore` against a real Blob endpoint (Azurite). Runs only when
//! `GT_AZURITE_BLOB_ENDPOINT` is set, e.g. after
//! `npx -p azurite azurite-blob --blobPort 10010 --location <dir> --skipApiVersionCheck --loose`:
//! `GT_AZURITE_BLOB_ENDPOINT=http://127.0.0.1:10010/devstoreaccount1`.

use bytes::Bytes;
use chrono::Utc;
use gt_core::config::AzureStorageConfig;
use gt_photos::blob::{BlobClient, BlobStore, SharedKeyCredential, CONTAINER_ALREADY_EXISTS, SERVICE_VERSION};
use http::{HeaderMap, HeaderValue, Method, StatusCode};

const ACCOUNT: &str = "devstoreaccount1";
const KEY: &str = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

fn connection_string() -> Option<String> {
    let endpoint = std::env::var("GT_AZURITE_BLOB_ENDPOINT").ok()?;
    Some(format!("DefaultEndpointsProtocol=http;AccountName={ACCOUNT};AccountKey={KEY};BlobEndpoint={endpoint};"))
}

/// Get Blob signed with Shared Key (the backend itself never downloads blobs).
async fn get_blob(endpoint: &str, container: &str, escaped_name: &str) -> (StatusCode, Option<String>, Bytes) {
    let url = url::Url::parse(&format!("{endpoint}/{container}/{escaped_name}")).unwrap();
    let mut headers = HeaderMap::new();
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    headers.insert("x-ms-date", HeaderValue::from_str(&date).unwrap());
    headers.insert("x-ms-version", HeaderValue::from_static(SERVICE_VERSION));
    let credential = SharedKeyCredential::new(ACCOUNT, KEY).unwrap();
    let auth = credential.authorization(&Method::GET, &url, &headers);
    headers.insert("authorization", HeaderValue::from_str(&auth).unwrap());
    let resp = reqwest::Client::new().get(url).headers(headers).send().await.unwrap();
    let status = resp.status();
    let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(str::to_string);
    (status, content_type, resp.bytes().await.unwrap())
}

#[tokio::test]
async fn container_upload_and_delete_round_trip() {
    let Some(conn) = connection_string() else {
        eprintln!("GT_AZURITE_BLOB_ENDPOINT not set; skipping");
        return;
    };
    let endpoint = std::env::var("GT_AZURITE_BLOB_ENDPOINT").unwrap();
    let container = format!("gt-photos-test-{}", std::process::id());
    let cfg = AzureStorageConfig {
        account_name: ACCOUNT.into(),
        connection_string: conn.clone(),
        container_name: container.clone(),
    };
    let store = BlobStore::from_config(&cfg, false).unwrap().expect("enabled");

    // First creation succeeds, a second one reports the existing container.
    store.client().create_container(&container).await.expect("create container");
    let err = store.client().create_container(&container).await.unwrap_err();
    assert_eq!(err.error_code(), Some(CONTAINER_ALREADY_EXISTS));
    assert_eq!(err.status(), Some(StatusCode::CONFLICT));
    store.ensure_container().await.expect("an existing container is fine");

    // Names with separators, colons and spaces are stored verbatim.
    let name = "activity-photos/42/2026-01-04/custom:ab c/0b7e7f8e_thumb.jpg";
    let data = Bytes::from_static(b"\xFF\xD8\xFFfake jpeg bytes");
    let url = store.upload(name, data.clone(), "image/jpeg").await.expect("upload");
    assert_eq!(
        url,
        format!("https://{ACCOUNT}.blob.core.windows.net/{container}/activity-photos/42/2026-01-04/custom:ab c/0b7e7f8e_thumb.jpg")
    );
    assert_eq!(store.blob_name_from_url(&url), name);

    let escaped = "activity-photos/42/2026-01-04/custom:ab%20c/0b7e7f8e_thumb.jpg";
    let (status, content_type, body) = get_blob(&endpoint, &container, escaped).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type.as_deref(), Some("image/jpeg"));
    assert_eq!(body, data);

    // Uploading again replaces the blob.
    store.upload(name, Bytes::from_static(b"v2"), "image/jpeg").await.expect("overwrite");
    assert_eq!(get_blob(&endpoint, &container, escaped).await.2, Bytes::from_static(b"v2"));

    store.delete(name).await.expect("delete");
    assert_eq!(get_blob(&endpoint, &container, escaped).await.0, StatusCode::NOT_FOUND);
    let err = store.delete(name).await.unwrap_err();
    assert_eq!(err.status(), Some(StatusCode::NOT_FOUND));
    assert_eq!(err.error_code(), Some("BlobNotFound"));
}

#[tokio::test]
async fn wrong_key_is_rejected() {
    let Some(_) = connection_string() else { return };
    let endpoint = std::env::var("GT_AZURITE_BLOB_ENDPOINT").unwrap();
    let bad =
        format!("DefaultEndpointsProtocol=http;AccountName={ACCOUNT};AccountKey=d3Jvbmcga2V5;BlobEndpoint={endpoint};");
    let client = BlobClient::from_connection_string(&bad).unwrap();
    let err = client.create_container("gt-photos-forbidden").await.unwrap_err();
    assert_eq!(err.status(), Some(StatusCode::FORBIDDEN));
    assert_eq!(err.error_code(), Some("AuthorizationFailure"));
}
