// Package models defines the domain entities for the application.
package models

import (
	"time"
)

// FollowState represents the state of a follow relationship
type FollowState string

const (
	FollowStateActive  FollowState = "ACTIVE"
	FollowStatePending FollowState = "PENDING"
	FollowStateRemoved FollowState = "REMOVED"
)

// RelationshipState represents the relationship state for UI display
type RelationshipState string

const (
	RelationshipNone            RelationshipState = "NONE"
	RelationshipFollowing       RelationshipState = "FOLLOWING"
	RelationshipRequested       RelationshipState = "REQUESTED"
	RelationshipIncomingPending RelationshipState = "INCOMING_PENDING"
)

// FollowEdgeByFollower represents a follow relationship indexed by follower
// This table is optimized for queries like "who does user X follow?"
type FollowEdgeByFollower struct {
	FollowerID uint        `gorm:"primaryKey;not null;index:idx_follow_follower_state,priority:1" json:"follower_id"`
	FolloweeID uint        `gorm:"primaryKey;not null" json:"followee_id"`
	State      FollowState `gorm:"type:varchar(20);not null;default:'ACTIVE';index:idx_follow_follower_state,priority:2" json:"state"`
	CreatedAt  time.Time   `gorm:"not null;default:now();autoCreateTime;index:idx_follow_follower_created,sort:desc" json:"created_at"`
	AcceptedAt *time.Time  `gorm:"default:null" json:"accepted_at,omitempty"`
	UpdatedAt  time.Time   `gorm:"not null;default:now();autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for FollowEdgeByFollower
func (FollowEdgeByFollower) TableName() string {
	return "follow_edges_by_follower"
}

// FollowEdgeByFollowee represents a follow relationship indexed by followee
// This table is optimized for queries like "who follows user X?"
type FollowEdgeByFollowee struct {
	FolloweeID uint        `gorm:"primaryKey;not null;index:idx_follow_followee_state,priority:1" json:"followee_id"`
	FollowerID uint        `gorm:"primaryKey;not null" json:"follower_id"`
	State      FollowState `gorm:"type:varchar(20);not null;default:'ACTIVE';index:idx_follow_followee_state,priority:2" json:"state"`
	CreatedAt  time.Time   `gorm:"not null;default:now();autoCreateTime;index:idx_follow_followee_created,sort:desc" json:"created_at"`
	AcceptedAt *time.Time  `gorm:"default:null" json:"accepted_at,omitempty"`
	UpdatedAt  time.Time   `gorm:"not null;default:now();autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for FollowEdgeByFollowee
func (FollowEdgeByFollowee) TableName() string {
	return "follow_edges_by_followee"
}

// FollowCounter stores aggregated follow counts for a user
// Updated asynchronously via events for eventual consistency
type FollowCounter struct {
	UserID               uint      `gorm:"primaryKey" json:"user_id"`
	FollowersCount       int64     `gorm:"not null;default:0" json:"followers_count"`
	FollowingCount       int64     `gorm:"not null;default:0" json:"following_count"`
	PendingRequestsCount int64     `gorm:"not null;default:0" json:"pending_requests_count"`
	UpdatedAt            time.Time `gorm:"not null;default:now();autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for FollowCounter
func (FollowCounter) TableName() string {
	return "follow_counters"
}

// FollowEvent represents an event published when follow state changes
type FollowEvent struct {
	Type       FollowEventType `json:"type"`
	FollowerID uint            `json:"follower_id"`
	FolloweeID uint            `json:"followee_id"`
	State      FollowState     `json:"state"`
	Timestamp  time.Time       `json:"timestamp"`
}

// FollowEventType represents the type of follow event
type FollowEventType string

const (
	FollowEventCreated  FollowEventType = "FOLLOW_CREATED"
	FollowEventAccepted FollowEventType = "FOLLOW_ACCEPTED"
	FollowEventRemoved  FollowEventType = "FOLLOW_REMOVED"
	FollowEventDeclined FollowEventType = "FOLLOW_DECLINED"
)

// FollowMetadata holds data for follow-related notifications
type FollowMetadata struct {
	ActorID       uint   `json:"actor_id"`
	ActorUsername string `json:"actor_username"`
	ActorAvatar   string `json:"actor_avatar,omitempty"`
}

// ToMap converts FollowMetadata to NotificationMetadata
func (m FollowMetadata) ToMap() NotificationMetadata {
	return NotificationMetadata{
		"actor_id":       m.ActorID,
		"actor_username": m.ActorUsername,
		"actor_avatar":   m.ActorAvatar,
	}
}
