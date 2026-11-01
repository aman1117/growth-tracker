//! Shared Key authorization for the Blob service (port of the Go SDK's
//! `exported.SharedKeyCredential`): HMAC-SHA256 over the canonicalized request.
//!
//! <https://learn.microsoft.com/rest/api/storageservices/authorize-with-shared-key>

use std::cmp::Ordering;
use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hmac::{Hmac, Mac};
use http::header::{
    HeaderMap, CONTENT_ENCODING, CONTENT_LANGUAGE, CONTENT_LENGTH, CONTENT_TYPE, IF_MATCH, IF_MODIFIED_SINCE,
    IF_NONE_MATCH, IF_UNMODIFIED_SINCE, RANGE,
};
use http::Method;
use sha2::Sha256;
use url::Url;

/// An account name plus its decoded key.
#[derive(Clone)]
pub struct SharedKeyCredential {
    account_name: String,
    key: Vec<u8>,
}

impl std::fmt::Debug for SharedKeyCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedKeyCredential").field("account_name", &self.account_name).finish_non_exhaustive()
    }
}

/// The account key is not valid standard base64 (Go: `decode account key: ...`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("decode account key: {0}")]
pub struct InvalidAccountKey(String);

impl SharedKeyCredential {
    /// Decodes the base64 `account_key`.
    pub fn new(account_name: &str, account_key: &str) -> Result<Self, InvalidAccountKey> {
        let key = BASE64.decode(account_key).map_err(|e| InvalidAccountKey(go_base64_error(&e, account_key)))?;
        Ok(Self { account_name: account_name.to_string(), key })
    }

    pub fn account_name(&self) -> &str {
        &self.account_name
    }

    /// The `Authorization` header value: `SharedKey <account>:<signature>`.
    pub fn authorization(&self, method: &Method, url: &Url, headers: &HeaderMap) -> String {
        let signature = self.sign(&self.string_to_sign(method, url, headers));
        format!("SharedKey {}:{signature}", self.account_name)
    }

    /// Base64 HMAC-SHA256 of `string_to_sign` with the account key.
    pub fn sign(&self, string_to_sign: &str) -> String {
        // HMAC accepts keys of any length, so this cannot fail.
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.key).expect("HMAC takes keys of any size");
        mac.update(string_to_sign.as_bytes());
        BASE64.encode(mac.finalize().into_bytes())
    }

    /// The string to sign for a request (`x-ms-date` is used, so the `Date` line is empty).
    pub fn string_to_sign(&self, method: &Method, url: &Url, headers: &HeaderMap) -> String {
        let header = |name| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
        let content_length = match header(CONTENT_LENGTH) {
            "0" => "",
            other => other,
        };
        [
            method.as_str(),
            header(CONTENT_ENCODING),
            header(CONTENT_LANGUAGE),
            content_length,
            header(http::HeaderName::from_static("content-md5")),
            header(CONTENT_TYPE),
            "",
            header(IF_MODIFIED_SINCE),
            header(IF_MATCH),
            header(IF_NONE_MATCH),
            header(IF_UNMODIFIED_SINCE),
            header(RANGE),
            &canonicalized_headers(headers),
            &self.canonicalized_resource(url),
        ]
        .join("\n")
    }

    /// `/<account><escaped path>` followed by `\n<lowercased name>:<sorted values>` for every
    /// query parameter, sorted by name.
    fn canonicalized_resource(&self, url: &Url) -> String {
        let mut out = format!("/{}", self.account_name);
        let path = url.path();
        out.push_str(if path.is_empty() { "/" } else { path });

        let mut params: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (name, value) in url.query_pairs() {
            params.entry(name.into_owned()).or_default().push(value.into_owned());
        }
        for (name, mut values) in params {
            values.sort();
            out.push('\n');
            out.push_str(&name.to_lowercase());
            out.push(':');
            out.push_str(&values.join(","));
        }
        out
    }
}

/// `x-ms-*` headers, lowercased, ordered with the service's collation and joined with `\n`.
fn canonicalized_headers(headers: &HeaderMap) -> String {
    let mut names: Vec<&str> =
        headers.keys().map(http::HeaderName::as_str).filter(|name| name.starts_with("x-ms-")).collect();
    names.sort_by(|a, b| compare_headers(a.as_bytes(), b.as_bytes()));
    names.dedup();
    names
        .iter()
        .map(|name| {
            let values: Vec<&str> = headers.get_all(*name).iter().map(|v| v.to_str().unwrap_or("")).collect();
            format!("{name}:{}", values.join(","))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Level-0 weights: hyphens (and other punctuation with weight 0) are ignored at this level.
#[rustfmt::skip]
const WEIGHTS_LV0: [u16; 128] = [
    0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
    0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
    0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x71c, 0x0, 0x71f, 0x721, 0x723, 0x725,
    0x0, 0x0, 0x0, 0x72d, 0x803, 0x0, 0x0, 0x733, 0x0, 0xd03, 0xd1a, 0xd1c, 0xd1e,
    0xd20, 0xd22, 0xd24, 0xd26, 0xd28, 0xd2a, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
    0xe02, 0xe09, 0xe0a, 0xe1a, 0xe21, 0xe23, 0xe25, 0xe2c, 0xe32, 0xe35, 0xe36, 0xe48, 0xe51,
    0xe70, 0xe7c, 0xe7e, 0xe89, 0xe8a, 0xe91, 0xe99, 0xe9f, 0xea2, 0xea4, 0xea6, 0xea7, 0xea9,
    0x0, 0x0, 0x0, 0x743, 0x744, 0x748, 0xe02, 0xe09, 0xe0a, 0xe1a, 0xe21, 0xe23, 0xe25,
    0xe2c, 0xe32, 0xe35, 0xe36, 0xe48, 0xe51, 0xe70, 0xe7c, 0xe7e, 0xe89, 0xe8a, 0xe91, 0xe99,
    0xe9f, 0xea2, 0xea4, 0xea6, 0xea7, 0xea9, 0x0, 0x74c, 0x0, 0x750, 0x0,
];

/// Level-2 weights: only `'` and `-` matter, breaking ties left by level 0.
const fn weights_lv2() -> [u16; 128] {
    let mut table = [0u16; 128];
    table[b'\'' as usize] = 0x8012;
    table[b'-' as usize] = 0x8212;
    table
}
const WEIGHTS_LV2: [u16; 128] = weights_lv2();

/// The Go SDK's `compareHeaders`: a multi-level, weight-based comparison matching how the
/// service sorts canonicalized headers (it differs from plain byte order around `-`).
fn compare_headers(lhs: &[u8], rhs: &[u8]) -> Ordering {
    let tables: [&[u16; 128]; 2] = [&WEIGHTS_LV0, &WEIGHTS_LV2];
    let weight = |table: &[u16; 128], s: &[u8], i: usize| -> u16 {
        match s.get(i) {
            Some(&b) => table.get(usize::from(b)).copied().unwrap_or(0),
            None => 0x1,
        }
    };
    let (mut level, mut i, mut j) = (0, 0, 0);
    while level < tables.len() {
        if level == tables.len() - 1 && i != j {
            return j.cmp(&i);
        }
        let w1 = weight(tables[level], lhs, i);
        let w2 = weight(tables[level], rhs, j);
        if w1 == 0x1 && w2 == 0x1 {
            i = 0;
            j = 0;
            level += 1;
        } else if w1 == w2 {
            i += 1;
            j += 1;
        } else if w1 == 0 {
            i += 1;
        } else if w2 == 0 {
            j += 1;
        } else {
            return w1.cmp(&w2);
        }
    }
    Ordering::Equal
}

/// Go's base64 error text: `illegal base64 data at input byte N`.
fn go_base64_error(err: &base64::DecodeError, input: &str) -> String {
    let offset = match err {
        base64::DecodeError::InvalidByte(offset, _) | base64::DecodeError::InvalidLastSymbol(offset, _) => *offset,
        base64::DecodeError::InvalidLength(len) => *len,
        base64::DecodeError::InvalidPadding => input.len(),
    };
    format!("illegal base64 data at input byte {offset}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    const AZURITE_KEY: &str =
        "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
    const DATE: &str = "Sat, 31 Oct 2026 23:38:22 GMT";

    fn credential() -> SharedKeyCredential {
        SharedKeyCredential::new("devstoreaccount1", AZURITE_KEY).unwrap()
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (name, value) in pairs {
            h.append(*name, HeaderValue::from_str(value).unwrap());
        }
        h
    }

    // The expected signatures were produced by the Go SDK (azblob v1.6.4) for the same requests.

    #[test]
    fn create_container_vector() {
        let url = Url::parse("http://127.0.0.1:10000/devstoreaccount1/profile-pictures?restype=container").unwrap();
        let h = headers(&[("x-ms-date", DATE), ("x-ms-version", "2026-02-06"), ("accept", "application/xml")]);
        assert_eq!(
            credential().authorization(&Method::PUT, &url, &h),
            "SharedKey devstoreaccount1:TWnd6/oLHN7l5l9xGMBsnSyW4Y7qfMktJE/8StUVD5U="
        );
    }

    #[test]
    fn put_blob_vector() {
        let url = Url::parse(
            "http://127.0.0.1:10000/devstoreaccount1/profile-pictures/\
             activity-photos%2F42%2F2026-01-04%2Fcustom:ab$c%20d%3Be%2Fuuid.jpg",
        )
        .unwrap();
        let h = headers(&[
            ("content-length", "11"),
            ("content-type", "application/octet-stream"),
            ("x-ms-date", DATE),
            ("x-ms-blob-content-type", "image/jpeg"),
            ("x-ms-blob-type", "BlockBlob"),
            ("x-ms-version", "2026-02-06"),
        ]);
        let cred = credential();
        assert_eq!(
            cred.string_to_sign(&Method::PUT, &url, &h),
            "PUT\n\n\n11\n\napplication/octet-stream\n\n\n\n\n\n\n\
             x-ms-blob-content-type:image/jpeg\nx-ms-blob-type:BlockBlob\nx-ms-date:Sat, 31 Oct 2026 23:38:22 GMT\n\
             x-ms-version:2026-02-06\n\
             /devstoreaccount1/devstoreaccount1/profile-pictures/activity-photos%2F42%2F2026-01-04%2Fcustom:ab$c%20d%3Be%2Fuuid.jpg"
        );
        assert_eq!(
            cred.authorization(&Method::PUT, &url, &h),
            "SharedKey devstoreaccount1:tI8exG+nCL69OkFjHexHpJSOLjG8Orv6UxioNVmLVq8="
        );
    }

    #[test]
    fn delete_blob_vector() {
        let url = Url::parse("http://127.0.0.1:10000/devstoreaccount1/profile-pictures/42%2Fabc.jpg").unwrap();
        let h = headers(&[("x-ms-date", DATE), ("x-ms-version", "2026-02-06"), ("content-length", "0")]);
        assert_eq!(
            credential().authorization(&Method::DELETE, &url, &h),
            "SharedKey devstoreaccount1:+dv1gqxTDnYZ2AKRbVXyxyjWw3bOKcYbp8OpLYtSzOs="
        );
    }

    #[test]
    fn query_parameters_are_sorted_and_lowercased() {
        let url = Url::parse("https://acct.blob.core.windows.net/c?restype=container&Comp=list&comp=b").unwrap();
        let resource = credential().canonicalized_resource(&url);
        assert_eq!(resource, "/devstoreaccount1/c\ncomp:list\ncomp:b\nrestype:container");
    }

    #[test]
    fn header_collation_ignores_hyphens_first() {
        assert_eq!(compare_headers(b"x-ms-blob-type", b"x-ms-blob-content-type"), Ordering::Greater);
        assert_eq!(compare_headers(b"x-ms-date", b"x-ms-version"), Ordering::Less);
        // Byte order would put "x-ms-a-b" (0x2d) before "x-ms-ab"; the service compares "xmsab"
        // first and only then the hyphen positions.
        assert_eq!(compare_headers(b"x-ms-ab", b"x-ms-a-b"), Ordering::Less);
        assert_eq!(compare_headers(b"x-ms-a", b"x-ms-a"), Ordering::Equal);
    }

    #[test]
    fn invalid_keys_are_rejected() {
        let err = SharedKeyCredential::new("a", "@@@").unwrap_err();
        assert_eq!(err.to_string(), "decode account key: illegal base64 data at input byte 0");
    }
}
