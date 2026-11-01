//! JWT access tokens (port of `internal/handlers/token.go`). Tokens are HS256 with the same
//! claims as the Go service (`user_id`, `username`, `exp`, `iat`), so sessions issued by either
//! implementation stay valid across a deploy.

use std::time::Duration;

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::config::JwtConfig;

/// JWT claims.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Claims {
    /// Missing or `null` reads as 0, like Go's zero value; handlers then reject the user.
    #[serde(default, deserialize_with = "null_as_default")]
    pub user_id: u64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nbf: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iat: Option<i64>,
}

/// Go's `encoding/json` leaves a field at its zero value for `null`.
fn null_as_default<'de, D, T>(de: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(de)?.unwrap_or_default())
}

/// A freshly issued token.
#[derive(Debug, Clone)]
pub struct IssuedToken {
    pub token: String,
    pub expires_at: DateTime<Utc>,
    /// Lifetime in whole seconds.
    pub expires_in: i64,
}

/// Issues and validates access tokens.
#[derive(Clone)]
pub struct TokenService {
    secret_key: String,
    access_ttl: Duration,
    #[allow(dead_code)]
    refresh_ttl: Duration,
}

impl TokenService {
    pub fn new(cfg: &JwtConfig) -> Self {
        Self {
            secret_key: cfg.secret_key.clone(),
            access_ttl: cfg.access_token_ttl,
            refresh_ttl: cfg.refresh_token_ttl,
        }
    }

    /// Issues an access token for the user.
    pub fn generate(&self, user_id: i64, username: &str) -> anyhow::Result<IssuedToken> {
        if self.secret_key.is_empty() {
            return Err(anyhow!("JWT_SECRET_KEY is not set"));
        }
        let now = Utc::now();
        let ttl = chrono::Duration::from_std(self.access_ttl)?;
        let exp = now + ttl;
        let claims = Claims {
            user_id: u64::try_from(user_id)?,
            username: username.to_string(),
            exp: Some(exp.timestamp()),
            nbf: None,
            iat: Some(now.timestamp()),
        };
        let token = jsonwebtoken::encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.secret_key.as_bytes()),
        )?;
        Ok(IssuedToken { token, expires_at: exp, expires_in: self.access_ttl.as_secs() as i64 })
    }

    /// Validates a token (any HMAC algorithm, `exp`/`nbf` checked when present, no leeway — the
    /// same rules as golang-jwt v5).
    pub fn parse(&self, token: &str) -> anyhow::Result<Claims> {
        // With an empty key anyone could sign a token that verifies.
        if self.secret_key.is_empty() {
            return Err(anyhow!("JWT_SECRET_KEY is not set"));
        }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.algorithms = vec![Algorithm::HS256, Algorithm::HS384, Algorithm::HS512];
        validation.leeway = 0;
        validation.validate_exp = true;
        validation.validate_nbf = true;
        validation.required_spec_claims.clear();
        validation.validate_aud = false;
        let data =
            jsonwebtoken::decode::<Claims>(token, &DecodingKey::from_secret(self.secret_key.as_bytes()), &validation)?;
        Ok(data.claims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc(secret: &str) -> TokenService {
        TokenService::new(&JwtConfig {
            secret_key: secret.into(),
            access_token_ttl: Duration::from_secs(3600),
            refresh_token_ttl: Duration::from_secs(7200),
        })
    }

    #[test]
    fn round_trips() {
        let s = svc("secret");
        let issued = s.generate(7, "amy").unwrap();
        assert_eq!(issued.expires_in, 3600);
        let claims = s.parse(&issued.token).unwrap();
        assert_eq!(claims.user_id, 7);
        assert_eq!(claims.username, "amy");
    }

    #[test]
    fn rejects_wrong_secret_and_empty_key() {
        let issued = svc("a").generate(1, "x").unwrap();
        assert!(svc("b").parse(&issued.token).is_err());
        assert!(svc("").parse(&issued.token).is_err());
        assert!(svc("").generate(1, "x").is_err());
    }

    #[test]
    fn accepts_go_issued_token() {
        // Issued by the Go backend (golang-jwt v5) with secret "test-secret", exp in 2100.
        let claims = Claims {
            user_id: 3,
            username: "go_user".into(),
            exp: Some(4_102_444_800),
            nbf: None,
            iat: Some(1_700_000_000),
        };
        let mut header = Header::new(Algorithm::HS256);
        header.typ = Some("JWT".into());
        let token = jsonwebtoken::encode(&header, &claims, &EncodingKey::from_secret(b"test-secret")).unwrap();
        assert_eq!(svc("test-secret").parse(&token).unwrap(), claims);
    }

    #[test]
    fn missing_or_null_identity_claims_read_as_zero_values() {
        let key = EncodingKey::from_secret(b"k");
        for body in [
            serde_json::json!({"username": "alice", "exp": 4_102_444_800i64}),
            serde_json::json!({"user_id": null, "username": null, "exp": 4_102_444_800i64}),
        ] {
            let token = jsonwebtoken::encode(&Header::new(Algorithm::HS256), &body, &key).unwrap();
            let claims = svc("k").parse(&token).unwrap();
            assert_eq!(claims.user_id, 0);
            assert_eq!(claims.username, body["username"].as_str().unwrap_or(""));
        }
    }

    #[test]
    fn rejects_expired() {
        let claims = Claims { user_id: 1, username: "x".into(), exp: Some(1), nbf: None, iat: None };
        let token =
            jsonwebtoken::encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(b"k")).unwrap();
        assert!(svc("k").parse(&token).is_err());
    }
}
