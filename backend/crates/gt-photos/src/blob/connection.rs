//! Connection string parsing with the exact rules of the Go SDK
//! (`azblob/internal/shared.ParseConnectionString`).

use std::collections::HashMap;

/// A parsed storage connection string.
#[derive(Clone, PartialEq, Eq)]
pub struct ParsedConnectionString {
    /// Blob service URL, always ending in `/`. For SAS connection strings the token is appended
    /// as the query (`https://acct.blob.core.windows.net/?sv=...`), as in Go.
    pub service_url: String,
    /// Empty for SAS connection strings.
    pub account_name: String,
    /// Base64 account key; empty for SAS connection strings.
    pub account_key: String,
}

impl std::fmt::Debug for ParsedConnectionString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The service URL may carry a SAS token and the key is a secret: never print them.
        f.debug_struct("ParsedConnectionString")
            .field("account_name", &self.account_name)
            .field("has_account_key", &!self.account_key.is_empty())
            .finish_non_exhaustive()
    }
}

/// Why a connection string was rejected (messages are the Go SDK's).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectionStringError {
    #[error(
        "connection string is either blank or malformed. The expected connection string should contain key value \
         pairs separated by semicolons. For example \
         'DefaultEndpointsProtocol=https;AccountName=<accountName>;AccountKey=<accountKey>;EndpointSuffix=core.windows.net'"
    )]
    Malformed,
    #[error("connection string needs either AccountName or BlobEndpoint")]
    MissingEndpoint,
    #[error("connection string needs either AccountKey or SharedAccessSignature")]
    MissingCredential,
}

const DEFAULT_SCHEME: &str = "https";
const DEFAULT_SUFFIX: &str = "core.windows.net";

/// Parses `key=value;...` pairs. `BlobEndpoint` (e.g. Azurite's
/// `http://127.0.0.1:10000/devstoreaccount1`) wins over the URL built from
/// `DefaultEndpointsProtocol`, `AccountName` and `EndpointSuffix`.
pub fn parse_connection_string(connection_string: &str) -> Result<ParsedConnectionString, ConnectionStringError> {
    let trimmed = connection_string.trim_end_matches(';');
    let mut pairs: HashMap<&str, &str> = HashMap::new();
    for part in trimmed.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            return Err(ConnectionStringError::Malformed);
        };
        pairs.insert(key, value);
    }

    let protocol = pairs.get("DefaultEndpointsProtocol").copied().unwrap_or(DEFAULT_SCHEME);
    let suffix = pairs.get("EndpointSuffix").copied().unwrap_or(DEFAULT_SUFFIX);
    let account_name = pairs.get("AccountName").copied();

    let mut service_url = match (pairs.get("BlobEndpoint"), account_name) {
        (Some(endpoint), _) => (*endpoint).to_string(),
        (None, Some(account)) => format!("{protocol}://{account}.blob.{suffix}"),
        (None, None) => return Err(ConnectionStringError::MissingEndpoint),
    };
    if !service_url.ends_with('/') {
        service_url.push('/');
    }

    match (account_name, pairs.get("AccountKey"), pairs.get("SharedAccessSignature")) {
        (Some(name), Some(key), _) => {
            Ok(ParsedConnectionString { service_url, account_name: name.to_string(), account_key: (*key).to_string() })
        }
        (_, _, Some(sas)) => Ok(ParsedConnectionString {
            service_url: format!("{service_url}?{sas}"),
            account_name: String::new(),
            account_key: String::new(),
        }),
        _ => Err(ConnectionStringError::MissingCredential),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AZURITE: &str = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;\
                           BlobEndpoint=http://azurite:10000/devstoreaccount1;";

    #[test]
    fn azurite_blob_endpoint_wins() {
        let parsed = parse_connection_string(AZURITE).unwrap();
        assert_eq!(parsed.service_url, "http://azurite:10000/devstoreaccount1/");
        assert_eq!(parsed.account_name, "devstoreaccount1");
        assert_eq!(parsed.account_key, "a2V5");
    }

    #[test]
    fn azure_account_url_from_parts() {
        let parsed = parse_connection_string("AccountName=acct;AccountKey=k==").unwrap();
        assert_eq!(parsed.service_url, "https://acct.blob.core.windows.net/");
        assert_eq!(parsed.account_key, "k==", "values may contain '='");

        let parsed = parse_connection_string(
            "DefaultEndpointsProtocol=http;AccountName=acct;AccountKey=k;EndpointSuffix=core.chinacloudapi.cn",
        )
        .unwrap();
        assert_eq!(parsed.service_url, "http://acct.blob.core.chinacloudapi.cn/");
    }

    #[test]
    fn sas_connection_strings() {
        let parsed = parse_connection_string(
            "BlobEndpoint=https://acct.blob.core.windows.net/;SharedAccessSignature=sv=1&sig=x",
        )
        .unwrap();
        assert_eq!(parsed.service_url, "https://acct.blob.core.windows.net/?sv=1&sig=x");
        assert!(parsed.account_name.is_empty());
    }

    #[test]
    fn rejects_like_go() {
        for bad in ["", "x", "not a connection string", "AccountName=a;junk"] {
            assert_eq!(parse_connection_string(bad), Err(ConnectionStringError::Malformed), "{bad:?}");
        }
        assert_eq!(parse_connection_string("AccountKey=k"), Err(ConnectionStringError::MissingEndpoint));
        assert_eq!(parse_connection_string("AccountName=a"), Err(ConnectionStringError::MissingCredential));
        assert_eq!(
            ConnectionStringError::MissingCredential.to_string(),
            "connection string needs either AccountKey or SharedAccessSignature"
        );
        assert!(ConnectionStringError::Malformed.to_string().starts_with(
            "connection string is either blank or malformed. The expected connection string should contain key value pairs"
        ));
    }
}
