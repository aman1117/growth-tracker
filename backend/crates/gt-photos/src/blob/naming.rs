//! Blob names and public URLs. The URL format is stored in the database and returned to the
//! frontend, so it must stay byte-identical to the Go backend's `generateBlobURL`.

use uuid::Uuid;

/// Builds the public URL of a blob.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicUrls {
    account_name: String,
    container: String,
    development: bool,
}

impl PublicUrls {
    /// `account_name` is `AZURE_STORAGE_ACCOUNT_NAME` (not the connection string's account);
    /// `development` is `ENV == "development"`.
    pub fn new(account_name: &str, container: &str, development: bool) -> Self {
        Self { account_name: account_name.to_string(), container: container.to_string(), development }
    }

    pub fn container(&self) -> &str {
        &self.container
    }

    /// Azurite's host URL in development, the Azure account URL otherwise. The blob name is
    /// inserted verbatim (not escaped), as in Go.
    pub fn blob_url(&self, blob_name: &str) -> String {
        if self.development {
            format!("http://localhost:10000/devstoreaccount1/{}/{blob_name}", self.container)
        } else {
            format!("https://{}.blob.core.windows.net/{}/{blob_name}", self.account_name, self.container)
        }
    }

    /// The blob name inside a stored URL (see [`extract_blob_name`]).
    pub fn blob_name_from_url(&self, url: &str) -> String {
        extract_blob_name(url, &self.container)
    }
}

/// Everything after the last `<container>/` in `url`, or `""` when the container does not
/// occur (Go: `strings.Split(url, container+"/")` and its last element). Works for Azure and
/// Azurite URLs alike.
pub fn extract_blob_name(url: &str, container: &str) -> String {
    let separator = format!("{container}/");
    let mut parts = url.split(separator.as_str());
    let first = parts.next();
    match (first, parts.last()) {
        (Some(_), Some(last)) => last.to_string(),
        _ => String::new(),
    }
}

/// The full-size and thumbnail blob names of one upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobNames {
    pub full: String,
    pub thumbnail: String,
}

/// A fresh random id for a blob pair (UUID v4, lowercase, hyphenated).
pub fn new_blob_id() -> Uuid {
    Uuid::new_v4()
}

/// `<userID>/<uuid>.jpg` and `<userID>/<uuid>_thumb.jpg` (always JPEG after processing).
pub fn profile_picture_blob_names(user_id: i64, id: &Uuid) -> BlobNames {
    BlobNames { full: format!("{user_id}/{id}.jpg"), thumbnail: format!("{user_id}/{id}_thumb.jpg") }
}

/// `activity-photos/<userID>/<YYYY-MM-DD>/<activity>/<uuid>.jpg` (+ `_thumb.jpg`). The activity
/// name is used verbatim, as in Go.
pub fn activity_photo_blob_names(user_id: i64, photo_date: &str, activity_name: &str, id: &Uuid) -> BlobNames {
    let base = format!("activity-photos/{user_id}/{photo_date}/{activity_name}");
    BlobNames { full: format!("{base}/{id}.jpg"), thumbnail: format!("{base}/{id}_thumb.jpg") }
}

/// Thumbnail blob name for an existing profile picture URL (backfill tool):
/// `42/abc.png` -> `42/abc_thumb.jpg`.
pub fn derive_thumb_blob_name(original_url: &str, container: &str) -> Result<String, String> {
    let separator = format!("{container}/");
    let parts: Vec<&str> = original_url.split(separator.as_str()).collect();
    let Some(blob_name) = parts.last().filter(|_| parts.len() >= 2) else {
        return Err(format!("cannot extract blob name from URL: {original_url}"));
    };
    Ok(match blob_name.rfind('.') {
        Some(dot) => format!("{}_thumb.jpg", &blob_name[..dot]),
        None => format!("{blob_name}_thumb.jpg"),
    })
}

/// The original URL with its blob name replaced by `thumb_blob_name` (backfill tool); the
/// original URL when it does not contain the container.
pub fn derive_thumb_url(original_url: &str, thumb_blob_name: &str, container: &str) -> String {
    let separator = format!("{container}/");
    match original_url.split(separator.as_str()).collect::<Vec<_>>().as_slice() {
        [first, _, ..] => format!("{first}{container}/{thumb_blob_name}"),
        _ => original_url.to_string(),
    }
}

/// Go's `url.PathEscape`: everything except unreserved characters and `$&+:=@` is
/// percent-encoded (including `/`, so a blob name is a single path segment).
pub fn go_path_escape(s: &str) -> String {
    escape(s, |b| matches!(b, b'$' | b'&' | b'+' | b':' | b'=' | b'@'), false)
}

/// Go's `url.QueryEscape`: unreserved characters stay, spaces become `+`.
pub fn go_query_escape(s: &str) -> String {
    escape(s, |_| false, true)
}

fn escape(s: &str, extra_safe: impl Fn(u8) -> bool, space_as_plus: bool) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') || extra_safe(b) {
            out.push(char::from(b));
        } else if b == b' ' && space_as_plus {
            out.push('+');
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(b >> 4)]));
            out.push(char::from(HEX[usize::from(b & 0xF)]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_urls_match_go() {
        let dev = PublicUrls::new("prodacct", "profile-pictures", true);
        assert_eq!(dev.blob_url("1/a.jpg"), "http://localhost:10000/devstoreaccount1/profile-pictures/1/a.jpg");
        let prod = PublicUrls::new("prodacct", "profile-pictures", false);
        assert_eq!(prod.blob_url("1/a.jpg"), "https://prodacct.blob.core.windows.net/profile-pictures/1/a.jpg");
        assert_eq!(
            prod.blob_url("activity-photos/1/2026-01-04/a b/x.jpg"),
            "https://prodacct.blob.core.windows.net/profile-pictures/activity-photos/1/2026-01-04/a b/x.jpg",
            "names are not escaped"
        );
    }

    #[test]
    fn blob_names_from_urls() {
        let c = "profile-pictures";
        assert_eq!(
            extract_blob_name("http://localhost:10000/devstoreaccount1/profile-pictures/1/old.jpg", c),
            "1/old.jpg"
        );
        assert_eq!(
            extract_blob_name("https://a.blob.core.windows.net/profile-pictures/7/p_thumb.jpg", c),
            "7/p_thumb.jpg"
        );
        assert_eq!(extract_blob_name("https://cdn.example.com/elsewhere.jpg", c), "");
        assert_eq!(extract_blob_name("x/profile-pictures/a/profile-pictures/b.jpg", c), "b.jpg", "last occurrence");
        assert_eq!(extract_blob_name("x/profile-pictures/", c), "");
    }

    #[test]
    fn naming_scheme() {
        let id = Uuid::parse_str("0b7e7f8e-4d3c-4a8e-9a55-0f2f6c1d2e3f").unwrap();
        assert_eq!(
            profile_picture_blob_names(42, &id),
            BlobNames {
                full: "42/0b7e7f8e-4d3c-4a8e-9a55-0f2f6c1d2e3f.jpg".into(),
                thumbnail: "42/0b7e7f8e-4d3c-4a8e-9a55-0f2f6c1d2e3f_thumb.jpg".into(),
            }
        );
        let names = activity_photo_blob_names(7, "2026-01-04", "custom:abc", &id);
        assert_eq!(names.full, "activity-photos/7/2026-01-04/custom:abc/0b7e7f8e-4d3c-4a8e-9a55-0f2f6c1d2e3f.jpg");
        assert!(names.thumbnail.ends_with("-0f2f6c1d2e3f_thumb.jpg"));
        assert_eq!(new_blob_id().to_string().len(), 36);
    }

    #[test]
    fn backfill_derivations() {
        let c = "profile-pictures";
        let url = "https://a.blob.core.windows.net/profile-pictures/42/abc-def.png";
        assert_eq!(derive_thumb_blob_name(url, c).unwrap(), "42/abc-def_thumb.jpg");
        assert_eq!(derive_thumb_blob_name("https://h/profile-pictures/42/noext", c).unwrap(), "42/noext_thumb.jpg");
        assert_eq!(
            derive_thumb_blob_name("https://cdn/x.jpg", c).unwrap_err(),
            "cannot extract blob name from URL: https://cdn/x.jpg"
        );
        assert_eq!(
            derive_thumb_url(url, "42/abc-def_thumb.jpg", c),
            "https://a.blob.core.windows.net/profile-pictures/42/abc-def_thumb.jpg"
        );
        assert_eq!(derive_thumb_url("https://cdn/x.jpg", "t.jpg", c), "https://cdn/x.jpg");
    }

    #[test]
    fn escaping_matches_go() {
        assert_eq!(
            go_path_escape("activity-photos/42/2026-01-04/custom:ab$c d;e/uuid.jpg"),
            "activity-photos%2F42%2F2026-01-04%2Fcustom:ab$c%20d%3Be%2Fuuid.jpg"
        );
        assert_eq!(go_path_escape("é?#,"), "%C3%A9%3F%23%2C");
        assert_eq!(go_query_escape("a b+c/=~"), "a+b%2Bc%2F%3D~");
    }
}
