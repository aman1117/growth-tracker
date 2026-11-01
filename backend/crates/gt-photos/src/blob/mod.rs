//! Azure Blob Storage over the REST API (the subset of `azblob` the Go backend used).
//!
//! * [`parse_connection_string`]: Go SDK connection string rules (Azure and Azurite);
//! * [`SharedKeyCredential`]: request signing;
//! * [`BlobClient`]: Create Container, Put Blob, Delete Blob with retries;
//! * [`BlobStore`]: the configured container plus public URL generation;
//! * [`naming`]: blob names and URLs stored in the database.

mod client;
mod connection;
pub mod naming;
mod shared_key;
mod store;

pub use client::{BlobClient, BlobError, RetryOptions, SERVICE_VERSION};
pub use connection::{parse_connection_string, ConnectionStringError, ParsedConnectionString};
pub use naming::{
    activity_photo_blob_names, derive_thumb_blob_name, derive_thumb_url, extract_blob_name, new_blob_id,
    profile_picture_blob_names, BlobNames, PublicUrls,
};
pub use shared_key::{InvalidAccountKey, SharedKeyCredential};
pub use store::{
    with_deadline, BlobStore, CONTAINER_ALREADY_EXISTS, CREATE_CONTAINER_TIMEOUT, DELETE_TIMEOUT, UPLOAD_TIMEOUT,
};
