use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::gojson;

// Follow edge states
pub const FOLLOW_STATE_ACTIVE: &str = "ACTIVE";
pub const FOLLOW_STATE_PENDING: &str = "PENDING";
pub const FOLLOW_STATE_REMOVED: &str = "REMOVED";

// Relationship states shown in the UI
pub const RELATIONSHIP_NONE: &str = "NONE";
pub const RELATIONSHIP_FOLLOWING: &str = "FOLLOWING";
pub const RELATIONSHIP_REQUESTED: &str = "REQUESTED";
pub const RELATIONSHIP_INCOMING_PENDING: &str = "INCOMING_PENDING";

// Follow event types (published on the `follow_events` Redis channel)
pub const FOLLOW_EVENT_CREATED: &str = "FOLLOW_CREATED";
pub const FOLLOW_EVENT_ACCEPTED: &str = "FOLLOW_ACCEPTED";
pub const FOLLOW_EVENT_REMOVED: &str = "FOLLOW_REMOVED";
pub const FOLLOW_EVENT_DECLINED: &str = "FOLLOW_DECLINED";

/// Follow edge indexed by follower (`follow_edges_by_follower`): "who does X follow?".
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct FollowEdgeByFollower {
    pub follower_id: i64,
    pub followee_id: i64,
    pub state: String,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "gojson::time_opt", skip_serializing_if = "Option::is_none")]
    pub accepted_at: Option<DateTime<Utc>>,
    #[serde(with = "gojson::time")]
    pub updated_at: DateTime<Utc>,
}

impl FollowEdgeByFollower {
    pub const COLUMNS: &'static str = "follower_id, followee_id, state, created_at, accepted_at, updated_at";
}

/// Follow edge indexed by followee (`follow_edges_by_followee`): "who follows X?".
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct FollowEdgeByFollowee {
    pub followee_id: i64,
    pub follower_id: i64,
    pub state: String,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "gojson::time_opt", skip_serializing_if = "Option::is_none")]
    pub accepted_at: Option<DateTime<Utc>>,
    #[serde(with = "gojson::time")]
    pub updated_at: DateTime<Utc>,
}

impl FollowEdgeByFollowee {
    pub const COLUMNS: &'static str = "followee_id, follower_id, state, created_at, accepted_at, updated_at";
}

/// Aggregated follow counts (`follow_counters`), updated asynchronously.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct FollowCounter {
    pub user_id: i64,
    pub followers_count: i64,
    pub following_count: i64,
    pub pending_requests_count: i64,
    #[serde(with = "gojson::time")]
    pub updated_at: DateTime<Utc>,
}

impl FollowCounter {
    pub const COLUMNS: &'static str = "user_id, followers_count, following_count, pending_requests_count, updated_at";
}

/// Event published when a follow edge changes state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FollowEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub follower_id: i64,
    pub followee_id: i64,
    pub state: String,
    #[serde(with = "gojson::time")]
    pub timestamp: DateTime<Utc>,
}

/// Follow-related notification metadata.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FollowMetadata {
    pub actor_id: i64,
    pub actor_username: String,
    pub actor_avatar: String,
}

impl FollowMetadata {
    pub fn to_map(&self) -> Value {
        json!({
            "actor_id": self.actor_id,
            "actor_username": self.actor_username,
            "actor_avatar": self.actor_avatar,
        })
    }
}
