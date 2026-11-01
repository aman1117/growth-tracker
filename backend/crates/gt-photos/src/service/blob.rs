//! Profile picture storage bookkeeping (port of Go's `services.BlobService`).

use std::sync::Arc;

use gt_core::config::AzureStorageConfig;
use gt_core::models::User;
use gt_users::repository::UserRepository;

/// User lookups and profile picture URL updates for the profile picture endpoints.
#[derive(Debug, Clone)]
pub struct BlobService {
    user_repo: Arc<UserRepository>,
    account_name: String,
    container: String,
    enabled: bool,
}

impl BlobService {
    pub fn new(user_repo: Arc<UserRepository>, cfg: &AzureStorageConfig) -> Self {
        Self {
            user_repo,
            account_name: cfg.account_name.clone(),
            container: cfg.container_name.clone(),
            enabled: !cfg.connection_string.is_empty(),
        }
    }

    /// Whether `AZURE_STORAGE_CONNECTION_STRING` is set.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub async fn get_user(&self, user_id: i64) -> Result<Option<User>, sqlx::Error> {
        self.user_repo.find_by_id(user_id).await
    }

    /// Sets (or with `None`, clears) the profile picture and thumbnail URLs.
    pub async fn update_profile_pic(
        &self,
        user_id: i64,
        url: Option<&str>,
        thumb_url: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        self.user_repo.update_profile_pic(user_id, url, thumb_url).await
    }

    /// The Azure (never Azurite) public URL of a blob.
    pub fn generate_public_url(&self, blob_name: &str) -> String {
        format!("https://{}.blob.core.windows.net/{}/{blob_name}", self.account_name, self.container)
    }
}
