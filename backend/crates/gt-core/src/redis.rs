//! Redis client and helpers (port of `pkg/redis/redis.go`).
//!
//! Redis is optional: until a server answers `PING`, [`get`] returns `None` and callers fall
//! back. [`init`] keeps retrying in the background (1 s doubling up to 30 s) so an outage at
//! startup does not disable Redis until the next restart. Key names and TTLs are identical to
//! the Go service, so tokens and caches written by either implementation stay valid.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context};
use arc_swap::ArcSwapOption;
use rand::RngCore;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;

use crate::constants as c;

/// A connected Redis client: `conn` multiplexes commands; `client` opens dedicated connections
/// (Pub/Sub).
#[derive(Clone)]
pub struct RedisHandle {
    pub client: redis::Client,
    pub conn: ConnectionManager,
}

static CURRENT: ArcSwapOption<RedisHandle> = ArcSwapOption::const_empty();
static RECONNECT: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

const PING_TIMEOUT: Duration = Duration::from_secs(5);
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(30);

fn not_initialized() -> anyhow::Error {
    anyhow!("redis client not initialized")
}

/// Connects to Redis. On failure Redis stays unavailable and a background task keeps retrying.
pub async fn init(url: &str) -> anyhow::Result<()> {
    if url.is_empty() {
        return Err(anyhow!("REDIS_URL is not set"));
    }
    let client = redis::Client::open(url).context("failed to parse REDIS_URL")?;
    stop_reconnect();

    match connect(&client).await {
        Ok(conn) => {
            CURRENT.store(Some(Arc::new(RedisHandle { client, conn })));
            Ok(())
        }
        Err(err) => {
            let task = tokio::spawn(reconnect(client));
            *RECONNECT.lock().unwrap_or_else(|e| e.into_inner()) = Some(task);
            Err(err.context("failed to connect to Redis (retrying in the background)"))
        }
    }
}

async fn connect(client: &redis::Client) -> anyhow::Result<ConnectionManager> {
    let config = ConnectionManagerConfig::new()
        .set_connection_timeout(PING_TIMEOUT)
        .set_response_timeout(Duration::from_secs(3));
    let mut conn = tokio::time::timeout(PING_TIMEOUT, ConnectionManager::new_with_config(client.clone(), config))
        .await
        .map_err(|_| anyhow!("timed out connecting to Redis"))??;
    let _: String = tokio::time::timeout(PING_TIMEOUT, redis::cmd("PING").query_async(&mut conn))
        .await
        .map_err(|_| anyhow!("timed out waiting for PING"))??;
    Ok(conn)
}

async fn reconnect(client: redis::Client) {
    let mut delay = RECONNECT_DELAY;
    loop {
        tokio::time::sleep(delay).await;
        if let Ok(conn) = connect(&client).await {
            CURRENT.store(Some(Arc::new(RedisHandle { client, conn })));
            tracing::info!("Redis connection established after retrying");
            return;
        }
        delay = (delay * 2).min(RECONNECT_MAX_DELAY);
    }
}

fn stop_reconnect() {
    if let Some(task) = RECONNECT.lock().unwrap_or_else(|e| e.into_inner()).take() {
        task.abort();
    }
}

/// The current client, or `None` when Redis is unavailable.
pub fn get() -> Option<Arc<RedisHandle>> {
    CURRENT.load_full()
}

/// A command connection (cheap clone of the multiplexed manager), or `None`.
pub fn conn() -> Option<ConnectionManager> {
    CURRENT.load().as_ref().map(|h| h.conn.clone())
}

/// Whether Redis is configured and available.
pub fn is_available() -> bool {
    CURRENT.load().is_some()
}

/// Replaces the client (tests) and stops any background reconnect. `None` simulates Redis
/// being unavailable.
pub fn set_handle(handle: Option<RedisHandle>) {
    stop_reconnect();
    CURRENT.store(handle.map(Arc::new));
}

/// Stops any background reconnect and drops the client.
pub fn close() {
    set_handle(None);
}

fn required_conn() -> anyhow::Result<ConnectionManager> {
    conn().ok_or_else(not_initialized)
}

/// Parses a stored user id like Go's `fmt.Sscanf(value, "%d", &uint)`.
fn parse_user_id(value: &str) -> anyhow::Result<i64> {
    let digits: String = value.trim_start().chars().take_while(|ch| ch.is_ascii_digit()).collect();
    digits.parse::<i64>().map_err(|e| anyhow!("failed to parse user ID: {e}"))
}

// ==================== Tokens ====================

fn random_hex_token(byte_len: usize) -> (String, String) {
    let mut bytes = vec![0u8; byte_len];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let raw = hex::encode(bytes);
    let hash = hash_token(&raw);
    (raw, hash)
}

/// SHA-256 of a token, hex-encoded.
pub fn hash_token(raw_token: &str) -> String {
    hex::encode(Sha256::digest(raw_token.as_bytes()))
}

/// Returns `(raw_token, token_hash)`: send the raw token to the user, store the hash.
pub fn generate_reset_token() -> (String, String) {
    random_hex_token(c::RESET_TOKEN_BYTE_LEN)
}

pub async fn store_reset_token(token_hash: &str, user_id: i64) -> anyhow::Result<()> {
    let mut conn = required_conn()?;
    let key = format!("{}{token_hash}", c::RESET_TOKEN_PREFIX);
    conn.set_ex::<_, _, ()>(key, user_id.to_string(), c::RESET_TOKEN_TTL.as_secs()).await?;
    Ok(())
}

/// The user id of a valid reset token without consuming it; `0` when unknown or expired.
pub async fn validate_reset_token(raw_token: &str) -> anyhow::Result<i64> {
    let mut conn = required_conn()?;
    let key = format!("{}{}", c::RESET_TOKEN_PREFIX, hash_token(raw_token));
    let value: Option<String> = conn.get(&key).await.map_err(|e| anyhow!("failed to get reset token: {e}"))?;
    match value {
        None => Ok(0),
        Some(v) => parse_user_id(&v),
    }
}

/// Validates and deletes a reset token (single use); `0` when unknown or expired.
pub async fn consume_reset_token(raw_token: &str) -> anyhow::Result<i64> {
    let mut conn = required_conn()?;
    let key = format!("{}{}", c::RESET_TOKEN_PREFIX, hash_token(raw_token));
    let value: Option<String> = conn.get(&key).await.map_err(|e| anyhow!("failed to get reset token: {e}"))?;
    let Some(value) = value else { return Ok(0) };
    let user_id = parse_user_id(&value)?;
    conn.del::<_, ()>(&key).await.map_err(|e| anyhow!("failed to delete reset token: {e}"))?;
    Ok(user_id)
}

pub async fn delete_reset_token(raw_token: &str) -> anyhow::Result<()> {
    let mut conn = required_conn()?;
    let key = format!("{}{}", c::RESET_TOKEN_PREFIX, hash_token(raw_token));
    conn.del::<_, ()>(key).await?;
    Ok(())
}

/// Returns `(raw_token, token_hash)` for email verification.
pub fn generate_verify_token() -> (String, String) {
    random_hex_token(c::VERIFY_TOKEN_BYTE_LEN)
}

pub async fn store_verify_token(token_hash: &str, user_id: i64) -> anyhow::Result<()> {
    let mut conn = required_conn()?;
    let key = format!("{}{token_hash}", c::VERIFY_TOKEN_PREFIX);
    conn.set_ex::<_, _, ()>(key, user_id.to_string(), c::VERIFY_TOKEN_TTL.as_secs()).await?;
    Ok(())
}

/// Atomically reads and deletes a verification token (`GETDEL`); `0` when unknown or expired.
pub async fn consume_verify_token(raw_token: &str) -> anyhow::Result<i64> {
    let mut conn = required_conn()?;
    let key = format!("{}{}", c::VERIFY_TOKEN_PREFIX, hash_token(raw_token));
    let value: Option<String> = redis::cmd("GETDEL")
        .arg(&key)
        .query_async(&mut conn)
        .await
        .map_err(|e| anyhow!("failed to get/delete verify token: {e}"))?;
    match value {
        None => Ok(0),
        Some(v) => parse_user_id(&v),
    }
}

/// Old verification tokens simply expire (they are not indexed by user), as in Go.
pub async fn delete_verify_tokens_for_user(_user_id: i64) -> anyhow::Result<()> {
    Ok(())
}

pub async fn set_verify_resend_cooldown(user_id: i64) -> anyhow::Result<()> {
    let mut conn = required_conn()?;
    let key = format!("{}{user_id}", c::VERIFY_RESEND_PREFIX);
    conn.set_ex::<_, _, ()>(key, "1", c::VERIFY_RESEND_COOLDOWN.as_secs()).await?;
    Ok(())
}

/// Whether the user must wait before another verification email.
pub async fn check_verify_resend_cooldown(user_id: i64) -> anyhow::Result<bool> {
    let mut conn = required_conn()?;
    let key = format!("{}{user_id}", c::VERIFY_RESEND_PREFIX);
    let value: Option<String> = conn.get(key).await.map_err(|e| anyhow!("failed to check cooldown: {e}"))?;
    Ok(value.is_some())
}

// ==================== Likes cache ====================

pub fn likes_cache_key(user_id: i64, date: &str) -> String {
    format!("{}{user_id}:{date}", c::LIKES_CACHE_PREFIX)
}

/// Cached likes JSON; empty string on a cache miss.
pub async fn get_likes_cache(user_id: i64, date: &str) -> anyhow::Result<String> {
    let mut conn = required_conn()?;
    let key = likes_cache_key(user_id, date);
    let value: Option<String> =
        conn.get(&key).await.map_err(|e| anyhow!("failed to get likes cache for key {key}: {e}"))?;
    Ok(value.unwrap_or_default())
}

pub async fn set_likes_cache(user_id: i64, date: &str, data: &str) -> anyhow::Result<()> {
    let mut conn = required_conn()?;
    let key = likes_cache_key(user_id, date);
    conn.set_ex::<_, _, ()>(&key, data, c::LIKES_CACHE_TTL.as_secs())
        .await
        .map_err(|e| anyhow!("failed to set likes cache for key {key}: {e}"))
}

pub async fn invalidate_likes_cache(user_id: i64, date: &str) -> anyhow::Result<()> {
    let mut conn = required_conn()?;
    let key = likes_cache_key(user_id, date);
    conn.del::<_, ()>(&key).await.map_err(|e| anyhow!("failed to invalidate likes cache for key {key}: {e}"))
}

// ==================== Autocomplete cache (optional: no-ops without Redis) ====================

pub const AUTOCOMPLETE_CACHE_PREFIX: &str = "autocomplete:users:";
pub const AUTOCOMPLETE_CACHE_TTL: Duration = Duration::from_secs(60);

pub fn autocomplete_cache_key(query: &str) -> String {
    format!("{AUTOCOMPLETE_CACHE_PREFIX}{query}")
}

pub async fn get_autocomplete_cache(query: &str) -> anyhow::Result<String> {
    let Some(mut conn) = conn() else { return Ok(String::new()) };
    let value: Option<String> =
        conn.get(autocomplete_cache_key(query)).await.map_err(|e| anyhow!("failed to get autocomplete cache: {e}"))?;
    Ok(value.unwrap_or_default())
}

pub async fn set_autocomplete_cache(query: &str, data: &str) -> anyhow::Result<()> {
    let Some(mut conn) = conn() else { return Ok(()) };
    conn.set_ex::<_, _, ()>(autocomplete_cache_key(query), data, AUTOCOMPLETE_CACHE_TTL.as_secs())
        .await
        .map_err(|e| anyhow!("failed to set autocomplete cache: {e}"))
}

// ==================== Story likes cache (optional) ====================

pub fn story_like_count_cache_key(photo_id: i64) -> String {
    format!("{}{photo_id}", c::STORY_LIKE_COUNT_CACHE_PREFIX)
}

pub fn story_liked_by_cache_key(photo_id: i64, user_id: i64) -> String {
    format!("{}{photo_id}:{user_id}", c::STORY_LIKED_BY_CACHE_PREFIX)
}

/// Cached like count, or `-1` on a miss / without Redis.
pub async fn get_story_like_count(photo_id: i64) -> anyhow::Result<i64> {
    let Some(mut conn) = conn() else { return Ok(-1) };
    let value: Option<String> = conn
        .get(story_like_count_cache_key(photo_id))
        .await
        .map_err(|e| anyhow!("failed to get story like count cache: {e}"))?;
    match value {
        None => Ok(-1),
        Some(v) => v.parse::<i64>().map_err(|e| anyhow!("failed to get story like count cache: {e}")),
    }
}

pub async fn set_story_like_count(photo_id: i64, count: i64) -> anyhow::Result<()> {
    let Some(mut conn) = conn() else { return Ok(()) };
    conn.set_ex::<_, _, ()>(story_like_count_cache_key(photo_id), count, c::STORY_LIKE_CACHE_TTL.as_secs())
        .await
        .map_err(|e| anyhow!("failed to set story like count cache: {e}"))
}

/// Increments the cached count only when it is cached (avoids creating stale data).
pub async fn increment_story_like_count(photo_id: i64) -> anyhow::Result<()> {
    let Some(mut conn) = conn() else { return Ok(()) };
    let script = redis::Script::new(
        r#"
        if redis.call("EXISTS", KEYS[1]) == 1 then
            return redis.call("INCR", KEYS[1])
        end
        return nil
        "#,
    );
    script
        .key(story_like_count_cache_key(photo_id))
        .invoke_async::<redis::Value>(&mut conn)
        .await
        .map(|_| ())
        .map_err(|e| anyhow!("failed to increment story like count: {e}"))
}

/// Decrements the cached count only when it is cached and positive.
pub async fn decrement_story_like_count(photo_id: i64) -> anyhow::Result<()> {
    let Some(mut conn) = conn() else { return Ok(()) };
    let script = redis::Script::new(
        r#"
        if redis.call("EXISTS", KEYS[1]) == 1 then
            local val = redis.call("GET", KEYS[1])
            if tonumber(val) > 0 then
                return redis.call("DECR", KEYS[1])
            end
        end
        return nil
        "#,
    );
    script
        .key(story_like_count_cache_key(photo_id))
        .invoke_async::<redis::Value>(&mut conn)
        .await
        .map(|_| ())
        .map_err(|e| anyhow!("failed to decrement story like count: {e}"))
}

pub async fn invalidate_story_like_count(photo_id: i64) -> anyhow::Result<()> {
    let Some(mut conn) = conn() else { return Ok(()) };
    conn.del::<_, ()>(story_like_count_cache_key(photo_id))
        .await
        .map_err(|e| anyhow!("failed to invalidate story like count cache: {e}"))
}

/// `(liked, found)` from the cache; `found` is false on a miss / without Redis.
pub async fn get_story_liked_by_user(photo_id: i64, user_id: i64) -> anyhow::Result<(bool, bool)> {
    let Some(mut conn) = conn() else { return Ok((false, false)) };
    let value: Option<String> = conn
        .get(story_liked_by_cache_key(photo_id, user_id))
        .await
        .map_err(|e| anyhow!("failed to get story liked by user cache: {e}"))?;
    Ok(match value {
        None => (false, false),
        Some(v) => (v == "1", true),
    })
}

pub async fn set_story_liked_by_user(photo_id: i64, user_id: i64, liked: bool) -> anyhow::Result<()> {
    let Some(mut conn) = conn() else { return Ok(()) };
    let value = if liked { "1" } else { "0" };
    conn.set_ex::<_, _, ()>(story_liked_by_cache_key(photo_id, user_id), value, c::STORY_LIKE_CACHE_TTL.as_secs())
        .await
        .map_err(|e| anyhow!("failed to set story liked by user cache: {e}"))
}

pub async fn invalidate_story_liked_by_user(photo_id: i64, user_id: i64) -> anyhow::Result<()> {
    let Some(mut conn) = conn() else { return Ok(()) };
    conn.del::<_, ()>(story_liked_by_cache_key(photo_id, user_id))
        .await
        .map_err(|e| anyhow!("failed to invalidate story liked by user cache: {e}"))
}

// ==================== Trending cache (optional) ====================

pub const TRENDING_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

pub async fn get_trending_cache(key: &str) -> anyhow::Result<String> {
    let Some(mut conn) = conn() else { return Ok(String::new()) };
    let value: Option<String> = conn.get(key).await.map_err(|e| anyhow!("failed to get trending cache: {e}"))?;
    Ok(value.unwrap_or_default())
}

pub async fn set_trending_cache(key: &str, data: &str) -> anyhow::Result<()> {
    let Some(mut conn) = conn() else { return Ok(()) };
    conn.set_ex::<_, _, ()>(key, data, TRENDING_CACHE_TTL.as_secs())
        .await
        .map_err(|e| anyhow!("failed to set trending cache: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_hex_and_hashed() {
        let (raw, hash) = generate_reset_token();
        assert_eq!(raw.len(), 64);
        assert_eq!(hash, hash_token(&raw));
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn parses_user_ids_like_sscanf() {
        assert_eq!(parse_user_id("42").unwrap(), 42);
        assert_eq!(parse_user_id("42abc").unwrap(), 42);
        assert!(parse_user_id("abc").is_err());
    }

    #[tokio::test]
    async fn helpers_degrade_without_redis() {
        set_handle(None);
        assert!(!is_available());
        assert_eq!(get_story_like_count(1).await.unwrap(), -1);
        assert_eq!(get_autocomplete_cache("x").await.unwrap(), "");
        assert!(store_reset_token("h", 1).await.is_err());
    }
}
