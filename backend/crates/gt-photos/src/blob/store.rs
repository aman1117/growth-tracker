//! The configured container: uploads, deletes and public URLs (what the Go `BlobHandler` and
//! `ActivityPhotoService` each did with their `azblob.Client`).

use std::future::Future;
use std::time::Duration;

use bytes::Bytes;
use gt_core::config::AzureStorageConfig;

use super::client::{BlobClient, BlobError};
use super::naming::PublicUrls;

/// Deadline of the startup container creation (Go: 30 s context).
pub const CREATE_CONTAINER_TIMEOUT: Duration = Duration::from_secs(30);
/// Deadline of an upload (Go: 60 s context).
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// Deadline of blob deletions (Go: 30 s context).
pub const DELETE_TIMEOUT: Duration = Duration::from_secs(30);

/// Service error code of an existing container.
pub const CONTAINER_ALREADY_EXISTS: &str = "ContainerAlreadyExists";

/// A blob client bound to `AZURE_STORAGE_CONTAINER`.
#[derive(Debug, Clone)]
pub struct BlobStore {
    client: BlobClient,
    urls: PublicUrls,
}

impl BlobStore {
    pub fn new(client: BlobClient, urls: PublicUrls) -> Self {
        Self { client, urls }
    }

    /// `Ok(None)` when `AZURE_STORAGE_CONNECTION_STRING` is empty (blob storage disabled);
    /// an error when the connection string is invalid. `development` selects Azurite URLs.
    pub fn from_config(cfg: &AzureStorageConfig, development: bool) -> Result<Option<Self>, BlobError> {
        if cfg.connection_string.is_empty() {
            return Ok(None);
        }
        let client = BlobClient::from_connection_string(&cfg.connection_string)?;
        let urls = PublicUrls::new(&cfg.account_name, &cfg.container_name, development);
        Ok(Some(Self::new(client, urls)))
    }

    pub fn container(&self) -> &str {
        self.urls.container()
    }

    pub fn client(&self) -> &BlobClient {
        &self.client
    }

    pub fn urls(&self) -> &PublicUrls {
        &self.urls
    }

    /// Creates the container; an existing one is not an error (Go checks for
    /// `ContainerAlreadyExists` in the error text).
    pub async fn ensure_container(&self) -> Result<(), BlobError> {
        match self.client.create_container(self.container()).await {
            Err(err) if err.error_code() == Some(CONTAINER_ALREADY_EXISTS) => Ok(()),
            other => other,
        }
    }

    /// Uploads `data` and returns the blob's public URL.
    pub async fn upload(&self, blob_name: &str, data: Bytes, content_type: &str) -> Result<String, BlobError> {
        self.client.upload(self.container(), blob_name, data, content_type).await?;
        Ok(self.public_url(blob_name))
    }

    pub async fn delete(&self, blob_name: &str) -> Result<(), BlobError> {
        self.client.delete_blob(self.container(), blob_name).await
    }

    /// See [`PublicUrls::blob_url`].
    pub fn public_url(&self, blob_name: &str) -> String {
        self.urls.blob_url(blob_name)
    }

    /// See [`PublicUrls::blob_name_from_url`].
    pub fn blob_name_from_url(&self, url: &str) -> String {
        self.urls.blob_name_from_url(url)
    }
}

/// Runs blob operations under one deadline, like a Go `context.WithTimeout` shared by several
/// calls; [`BlobError::Timeout`] when it passes.
pub async fn with_deadline<T>(
    timeout: Duration,
    fut: impl Future<Output = Result<T, BlobError>>,
) -> Result<T, BlobError> {
    tokio::time::timeout(timeout, fut).await.unwrap_or(Err(BlobError::Timeout))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(connection_string: &str) -> AzureStorageConfig {
        AzureStorageConfig {
            account_name: "prodacct".into(),
            connection_string: connection_string.into(),
            container_name: "profile-pictures".into(),
        }
    }

    #[test]
    fn disabled_without_connection_string() {
        assert!(BlobStore::from_config(&cfg(""), true).unwrap().is_none());
        assert!(BlobStore::from_config(&cfg("not a connection string"), true).is_err());
    }

    #[test]
    fn urls_use_the_configured_account_and_container() {
        let store = BlobStore::from_config(&cfg("AccountName=other;AccountKey=a2V5"), false).unwrap().unwrap();
        assert_eq!(store.container(), "profile-pictures");
        assert_eq!(store.public_url("1/a.jpg"), "https://prodacct.blob.core.windows.net/profile-pictures/1/a.jpg");
        assert_eq!(
            store.blob_name_from_url("https://prodacct.blob.core.windows.net/profile-pictures/1/a.jpg"),
            "1/a.jpg"
        );
    }

    #[tokio::test]
    async fn deadlines() {
        let slow = async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok::<_, BlobError>(1)
        };
        assert!(matches!(with_deadline(Duration::from_millis(10), slow).await, Err(BlobError::Timeout)));
        assert_eq!(with_deadline(Duration::from_secs(1), async { Ok::<_, BlobError>(2) }).await.unwrap(), 2);
    }
}
