//! Web Push delivery: RFC 8291 `aes128gcm` payload encryption and RFC 8292 VAPID
//! authentication, reproducing `SherClockHolmes/webpush-go` v1.4.0 (the library the Go push
//! worker uses) byte for byte where it matters: every payload is padded to fill a 4096-byte
//! record, keys are decoded with the same base64 fallbacks and the VAPID JWT has the same claims.

use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use chrono::{DateTime, Utc};
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand::RngCore;
use sha2::Sha256;

/// webpush-go `MaxRecordSize`.
pub const MAX_RECORD_SIZE: u32 = 4096;
/// Lifetime of the VAPID JWT (webpush-go always uses now + 12 h).
const VAPID_EXPIRATION: Duration = Duration::from_secs(12 * 3600);
/// Go's `http.Client{}` uses a 30 s dial timeout and no overall timeout.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// A Web Push failure before a response was received. Messages follow the Go library's where
/// they can (they end up in `push_delivery_logs.error`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct WebPushError(pub String);

/// The browser's subscription (Go: `webpush.Subscription`).
#[derive(Debug, Clone, Copy)]
pub struct Subscription<'a> {
    pub endpoint: &'a str,
    /// Base64 (any alphabet, padding optional) uncompressed P-256 public key.
    pub p256dh: &'a str,
    /// Base64 authentication secret.
    pub auth: &'a str,
}

/// Sending options (the subset of `webpush.Options` the worker sets).
#[derive(Debug, Clone, Copy)]
pub struct Options<'a> {
    /// VAPID `sub`; prefixed with `mailto:` unless it starts with `https:` (webpush-go quirk:
    /// a configured `mailto:` subject becomes `mailto:mailto:...`, as in production).
    pub subscriber: &'a str,
    /// Base64url raw (65-byte uncompressed) public key.
    pub vapid_public_key: &'a str,
    /// Base64url raw 32-byte private scalar.
    pub vapid_private_key: &'a str,
    /// `TTL` header, in seconds.
    pub ttl: i64,
}

/// An HTTP client configured like Go's default client (no overall timeout).
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).build().unwrap_or_default()
}

/// Encrypts `message` for the subscription and POSTs it to the push service; returns the HTTP
/// status (Go: `webpush.SendNotification`, whose response the worker only reads the status of).
pub async fn send_notification(
    client: &reqwest::Client,
    message: &[u8],
    sub: &Subscription<'_>,
    options: &Options<'_>,
) -> Result<u16, WebPushError> {
    let auth_secret = decode_subscription_key(sub.auth)?;
    let ua_public = decode_subscription_key(sub.p256dh)?;
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let local_secret = SecretKey::random(&mut rand::rngs::OsRng);
    let body = encrypt(message, &ua_public, &auth_secret, &salt, &local_secret)?;

    let url = reqwest::Url::parse(sub.endpoint).map_err(|e| WebPushError(format!("parse {:?}: {e}", sub.endpoint)))?;
    let authorization = vapid_authorization(
        sub.endpoint,
        options.subscriber,
        options.vapid_public_key,
        options.vapid_private_key,
        Utc::now(),
    )?;
    let response = client
        .post(url)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", options.ttl.to_string())
        .header("Authorization", authorization)
        .body(body)
        .send()
        .await
        .map_err(|e| WebPushError(format!("Post {:?}: {e}", sub.endpoint)))?;
    Ok(response.status().as_u16())
}

/// The `aes128gcm` body for `message` (RFC 8291): an 86-byte header (salt, record size 4096,
/// the ephemeral public key) followed by one record padded to the full record size.
pub fn encrypt(
    message: &[u8],
    ua_public: &[u8],
    auth_secret: &[u8],
    salt: &[u8; 16],
    local_secret: &SecretKey,
) -> Result<Vec<u8>, WebPushError> {
    // Go: elliptic.Unmarshal accepts only uncompressed points on the curve.
    let invalid_point = || WebPushError("Unmarshal Error: Public key is not a valid point on the curve".into());
    if ua_public.len() != 65 || ua_public[0] != 0x04 {
        return Err(invalid_point());
    }
    let ua_key = PublicKey::from_sec1_bytes(ua_public).map_err(|_| invalid_point())?;
    let local_public = local_secret.public_key().to_encoded_point(false);
    let local_public = local_public.as_bytes();
    let shared = p256::ecdh::diffie_hellman(local_secret.to_nonzero_scalar(), ua_key.as_affine());

    let (cek, nonce) = derive_content_keys(shared.raw_secret_bytes(), auth_secret, ua_public, local_public, salt)?;

    let mut out = Vec::with_capacity(MAX_RECORD_SIZE as usize);
    out.extend_from_slice(salt);
    out.extend_from_slice(&MAX_RECORD_SIZE.to_be_bytes());
    out.push(local_public.len() as u8);
    out.extend_from_slice(local_public);

    // Padding delimiter, then zeros up to the record size minus the tag and the header.
    let max_plaintext = MAX_RECORD_SIZE as usize - 16 - out.len();
    let mut plaintext = Vec::with_capacity(max_plaintext);
    plaintext.extend_from_slice(message);
    plaintext.push(0x02);
    if plaintext.len() > max_plaintext {
        return Err(WebPushError("payload has exceeded the maximum length".into()));
    }
    plaintext.resize(max_plaintext, 0);

    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|e| WebPushError(e.to_string()))?;
    let ciphertext =
        cipher.encrypt(Nonce::from_slice(&nonce), plaintext.as_slice()).map_err(|e| WebPushError(e.to_string()))?;
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// RFC 8291 key schedule: IKM from the ECDH secret and auth secret, then the content
/// encryption key (16 bytes) and nonce (12 bytes) from the salt.
fn derive_content_keys(
    ecdh_secret: &[u8],
    auth_secret: &[u8],
    ua_public: &[u8],
    as_public: &[u8],
    salt: &[u8],
) -> Result<([u8; 16], [u8; 12]), WebPushError> {
    let hkdf_error = |e: hkdf::InvalidLength| WebPushError(e.to_string());
    let mut key_info = Vec::with_capacity(14 + 130);
    key_info.extend_from_slice(b"WebPush: info\x00");
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), ecdh_secret).expand(&key_info, &mut ikm).map_err(hkdf_error)?;

    let content = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    content.expand(b"Content-Encoding: aes128gcm\x00", &mut cek).map_err(hkdf_error)?;
    let mut nonce = [0u8; 12];
    content.expand(b"Content-Encoding: nonce\x00", &mut nonce).map_err(hkdf_error)?;
    Ok((cek, nonce))
}

/// `vapid t=<JWT>, k=<public key>` for the endpoint's origin (RFC 8292), like webpush-go:
/// ES256 JWT with header `{"alg":"ES256","typ":"JWT"}` and claims `aud` (scheme://host), `exp`
/// (now + 12 h) and `sub`.
pub fn vapid_authorization(
    endpoint: &str,
    subscriber: &str,
    vapid_public_key: &str,
    vapid_private_key: &str,
    now: DateTime<Utc>,
) -> Result<String, WebPushError> {
    let audience = origin(endpoint);
    let subscriber =
        if subscriber.starts_with("https:") { subscriber.to_string() } else { format!("mailto:{subscriber}") };
    let claims = serde_json::json!({
        "aud": audience,
        "exp": now.timestamp() + VAPID_EXPIRATION.as_secs() as i64,
        "sub": subscriber,
    });
    let claims = gt_core::gojson::to_vec(&claims).map_err(|e| WebPushError(e.to_string()))?;

    let private_key = decode_vapid_key(vapid_private_key)?;
    let signing_key =
        SigningKey::from_slice(&private_key).map_err(|_| WebPushError("crypto/ecdsa: invalid private key".into()))?;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let signing_input = format!("{}.{}", b64.encode(br#"{"alg":"ES256","typ":"JWT"}"#), b64.encode(claims));
    let signature: Signature = signing_key.sign(signing_input.as_bytes());
    let jwt = format!("{signing_input}.{}", b64.encode(signature.to_bytes()));

    let public_key = decode_vapid_key(vapid_public_key)?;
    Ok(format!("vapid t={jwt}, k={}", b64.encode(public_key)))
}

/// `scheme://host` of a URL like Go's `url.Parse` (lower-case scheme, host with port, no
/// userinfo).
fn origin(endpoint: &str) -> String {
    let endpoint = endpoint.split('#').next().unwrap_or_default();
    let (scheme, rest) = match endpoint.split_once(':') {
        Some((scheme, rest))
            if scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) =>
        {
            (scheme.to_ascii_lowercase(), rest)
        }
        _ => (String::new(), endpoint),
    };
    let host = rest
        .strip_prefix("//")
        .map(|r| {
            let authority = r.split(['/', '?']).next().unwrap_or_default();
            authority.rsplit_once('@').map_or(authority, |(_, host)| host)
        })
        .unwrap_or_default();
    format!("{scheme}://{host}")
}

/// Go's base64 decoders are lenient about the unused bits of the last character.
fn engine(alphabet: &alphabet::Alphabet, padding: DecodePaddingMode) -> GeneralPurpose {
    GeneralPurpose::new(
        alphabet,
        GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(padding),
    )
}

fn go_base64_error(err: base64::DecodeError) -> WebPushError {
    let offset = match err {
        base64::DecodeError::InvalidByte(offset, _) | base64::DecodeError::InvalidLastSymbol(offset, _) => offset,
        base64::DecodeError::InvalidLength(len) => len,
        base64::DecodeError::InvalidPadding => 0,
    };
    WebPushError(format!("illegal base64 data at input byte {offset}"))
}

/// webpush-go `decodeSubscriptionKey`: pad with `=` to a multiple of 4, then try the standard
/// alphabet and fall back to the URL-safe one.
pub fn decode_subscription_key(key: &str) -> Result<Vec<u8>, WebPushError> {
    let mut padded = key.to_string();
    let rem = key.len() % 4;
    if rem != 0 {
        padded.push_str(&"=".repeat(4 - rem));
    }
    engine(&alphabet::STANDARD, DecodePaddingMode::RequireCanonical)
        .decode(&padded)
        .or_else(|_| engine(&alphabet::URL_SAFE, DecodePaddingMode::RequireCanonical).decode(&padded))
        .map_err(go_base64_error)
}

/// webpush-go `decodeVapidKey`: padded URL-safe base64, falling back to unpadded.
pub fn decode_vapid_key(key: &str) -> Result<Vec<u8>, WebPushError> {
    engine(&alphabet::URL_SAFE, DecodePaddingMode::RequireCanonical)
        .decode(key)
        .or_else(|_| engine(&alphabet::URL_SAFE, DecodePaddingMode::RequireNone).decode(key))
        .map_err(go_base64_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;

    fn b64(s: &str) -> Vec<u8> {
        decode_vapid_key(s).unwrap()
    }

    // RFC 8291 Appendix A.
    const PLAINTEXT: &str = "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24";
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const AS_PUBLIC: &str = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const UA_PUBLIC: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const HEADER: &str =
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const CIPHERTEXT: &str = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";
    const CEK: &str = "oIhVW04MRdy2XN9CiKLxTg";
    const NONCE: &str = "4h_95klXJ5E_qnoN";

    #[test]
    fn encrypts_the_rfc_8291_example_with_go_padding() {
        let salt: [u8; 16] = b64(SALT).try_into().unwrap();
        let secret = SecretKey::from_slice(&b64(AS_PRIVATE)).unwrap();
        assert_eq!(secret.public_key().to_encoded_point(false).as_bytes(), b64(AS_PUBLIC).as_slice());
        let message = b64(PLAINTEXT);

        let body = encrypt(&message, &b64(UA_PUBLIC), &b64(AUTH), &salt, &secret).unwrap();

        assert_eq!(body.len(), MAX_RECORD_SIZE as usize, "padded to a full record like webpush-go");
        let header = b64(HEADER);
        assert_eq!(&body[..86], header.as_slice());
        // AES-GCM is a stream cipher: the record starts like the RFC's unpadded ciphertext.
        let rfc = b64(CIPHERTEXT);
        let unpadded_len = message.len() + 1;
        assert_eq!(&body[86..86 + unpadded_len], &rfc[..unpadded_len]);

        let cipher = Aes128Gcm::new_from_slice(&b64(CEK)).unwrap();
        let plaintext = cipher.decrypt(Nonce::from_slice(&b64(NONCE)), &body[86..]).unwrap();
        assert_eq!(&plaintext[..message.len()], message.as_slice());
        assert_eq!(plaintext[message.len()], 0x02);
        assert!(plaintext[message.len() + 1..].iter().all(|&b| b == 0));
    }

    #[test]
    fn rejects_bad_keys_and_oversized_payloads() {
        let salt = [0u8; 16];
        let secret = SecretKey::from_slice(&b64(AS_PRIVATE)).unwrap();
        let err = encrypt(b"hi", &[4u8; 65], &b64(AUTH), &salt, &secret).unwrap_err();
        assert_eq!(err.0, "Unmarshal Error: Public key is not a valid point on the curve");
        let compressed = PublicKey::from_sec1_bytes(&b64(UA_PUBLIC)).unwrap().to_encoded_point(true);
        assert!(encrypt(b"hi", compressed.as_bytes(), &b64(AUTH), &salt, &secret).is_err());
        let err = encrypt(&[b'x'; 3995], &b64(UA_PUBLIC), &b64(AUTH), &salt, &secret).unwrap_err();
        assert_eq!(err.0, "payload has exceeded the maximum length");
        assert!(encrypt(&[b'x'; 3993], &b64(UA_PUBLIC), &b64(AUTH), &salt, &secret).is_ok());
    }

    #[test]
    fn decodes_keys_like_webpush_go() {
        let raw = b64(UA_PUBLIC);
        let std_padded = base64::engine::general_purpose::STANDARD.encode(&raw);
        assert_eq!(decode_subscription_key(UA_PUBLIC).unwrap(), raw);
        assert_eq!(decode_subscription_key(&std_padded).unwrap(), raw);
        assert_eq!(decode_subscription_key(std_padded.trim_end_matches('=')).unwrap(), raw);
        assert_eq!(decode_subscription_key("a!b").unwrap_err().0, "illegal base64 data at input byte 1");
        assert_eq!(decode_vapid_key(&format!("{AS_PRIVATE}=")).unwrap(), b64(AS_PRIVATE));
    }

    #[test]
    fn vapid_header_matches_webpush_go() {
        let now = DateTime::from_timestamp(1_700_000_000, 0).unwrap();
        let header = vapid_authorization(
            "https://fcm.googleapis.com/fcm/send/abc?x=1",
            "mailto:ops@example.com",
            AS_PUBLIC,
            AS_PRIVATE,
            now,
        )
        .unwrap();
        let (token, key) = header.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(key, AS_PUBLIC);
        let parts: Vec<&str> = token.split('.').collect();
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        assert_eq!(b64.decode(parts[0]).unwrap(), br#"{"alg":"ES256","typ":"JWT"}"#);
        assert_eq!(
            String::from_utf8(b64.decode(parts[1]).unwrap()).unwrap(),
            r#"{"aud":"https://fcm.googleapis.com","exp":1700043200,"sub":"mailto:mailto:ops@example.com"}"#
        );
        let verifying = VerifyingKey::from_sec1_bytes(&decode_vapid_key(AS_PUBLIC).unwrap()).unwrap();
        let signature = Signature::from_slice(&b64.decode(parts[2]).unwrap()).unwrap();
        verifying.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).unwrap();

        let https_sub =
            vapid_authorization("https://push.example.com:8443/x", "https://example.com", AS_PUBLIC, AS_PRIVATE, now)
                .unwrap();
        let claims = b64.decode(https_sub.split('.').nth(1).unwrap()).unwrap();
        assert_eq!(
            String::from_utf8(claims).unwrap(),
            r#"{"aud":"https://push.example.com:8443","exp":1700043200,"sub":"https://example.com"}"#
        );
        assert!(vapid_authorization("https://x", "s", AS_PUBLIC, "!!!", now).is_err());
    }

    #[test]
    fn origins_like_go_url_parse() {
        assert_eq!(origin("HTTPS://user@Push.Example.com:443/a/b#frag"), "https://Push.Example.com:443");
        assert_eq!(
            origin("https://updates.push.services.mozilla.com/wpush/v2/x"),
            "https://updates.push.services.mozilla.com"
        );
        assert_eq!(origin("push.example.com/x"), "://");
    }
}
