// Package models defines the domain entities for the application.
package models

import (
	"time"
)

// PushSubscriptionStatus represents the status of a push subscription
type PushSubscriptionStatus string

const (
	PushSubscriptionStatusActive  PushSubscriptionStatus = "active"
	PushSubscriptionStatusGone    PushSubscriptionStatus = "gone"    // 404/410 from push service
	PushSubscriptionStatusExpired PushSubscriptionStatus = "expired" // User unsubscribed or stale
)

// PushSubscription represents a Web Push subscription for a user's device
type PushSubscription struct {
	ID           uint                   `gorm:"primaryKey" json:"id"`
	UserID       uint                   `gorm:"not null;index:idx_push_sub_user_status" json:"user_id"`
	Endpoint     string                 `gorm:"type:text;not null;uniqueIndex:idx_push_sub_endpoint" json:"endpoint"`
	P256dh       string                 `gorm:"type:text;not null" json:"p256dh"`               // Public key for encryption
	Auth         string                 `gorm:"type:text;not null" json:"auth"`                 // Auth secret for encryption
	VapidKeyID   string                 `gorm:"type:varchar(100);not null" json:"vapid_key_id"` // VAPID key used for this subscription
	Status       PushSubscriptionStatus `gorm:"type:varchar(20);not null;default:'active';index:idx_push_sub_user_status" json:"status"`
	FailureCount int                    `gorm:"not null;default:0" json:"failure_count"`

	// Device metadata
	UserAgent string `gorm:"type:varchar(500)" json:"user_agent"`
	Platform  string `gorm:"type:varchar(50)" json:"platform"` // windows, macos, linux, android, ios
	Browser   string `gorm:"type:varchar(50)" json:"browser"`  // chrome, firefox, edge, safari

	// Timestamps
	LastSuccessAt *time.Time `gorm:"index:idx_push_sub_last_success" json:"last_success_at"`
	LastFailureAt *time.Time `json:"last_failure_at"`
	CreatedAt     time.Time  `gorm:"not null;default:now();autoCreateTime" json:"created_at"`
	UpdatedAt     time.Time  `gorm:"not null;default:now();autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for PushSubscription
func (PushSubscription) TableName() string {
	return "push_subscriptions"
}

// IsActive returns true if the subscription is active
func (p *PushSubscription) IsActive() bool {
	return p.Status == PushSubscriptionStatusActive
}

// MarkGone marks the subscription as gone (dead endpoint)
func (p *PushSubscription) MarkGone() {
	p.Status = PushSubscriptionStatusGone
	now := time.Now()
	p.LastFailureAt = &now
}
