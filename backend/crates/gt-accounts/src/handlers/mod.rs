//! HTTP handlers of the accounts API, one module per Go handler file.

pub(crate) mod auth;
pub(crate) mod fiber;
pub(crate) mod follow;
pub(crate) mod password_reset;
pub(crate) mod profile;
pub(crate) mod search_suggestions;
pub(crate) mod verification;
