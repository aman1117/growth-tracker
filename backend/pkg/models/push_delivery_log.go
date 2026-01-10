// Package models defines the domain entities for the application.
package models

import (
	"time"
)

// PushDeliveryLog records each push delivery attempt for auditing and idempotency
type PushDeliveryLog struct {
	ID               uint   `gorm:"primaryKey" json:"id"`
	UserID           uint   `gorm:"not null;index:idx_push_log_user_created" json:"user_id"`
	SubscriptionID   uint   `gorm:"not null;index:idx_push_log_idempotency" json:"subscription_id"`
	NotificationType string `gorm:"type:varchar(50);not null" json:"notification_type"`
	DedupeKey        string `gorm:"type:varchar(255);index:idx_push_log_dedupe" json:"dedupe_key"`
	MessageID        string `gorm:"type:varchar(100);not null;index:idx_push_log_idempotency" json:"message_id"` // Service Bus message ID

	// Delivery result
	StatusCode int    `gorm:"not null" json:"status_code"` // HTTP status code from push service
	Error      string `gorm:"type:text" json:"error"`      // Error message if failed
	DurationMs int64  `gorm:"not null" json:"duration_ms"` // Request duration in milliseconds

	// Timestamp
	CreatedAt time.Time `gorm:"not null;default:now();autoCreateTime;index:idx_push_log_user_created,sort:desc;index:idx_push_log_dedupe" json:"created_at"`
}

// TableName specifies the table name for PushDeliveryLog
func (PushDeliveryLog) TableName() string {
	return "push_delivery_logs"
}

// IsSuccess returns true if the delivery was successful
func (p *PushDeliveryLog) IsSuccess() bool {
	return p.StatusCode >= 200 && p.StatusCode < 300
}

// IsPermanentFailure returns true if the endpoint is permanently gone
func (p *PushDeliveryLog) IsPermanentFailure() bool {
	return p.StatusCode == 404 || p.StatusCode == 410
}

// IsRetryable returns true if the delivery should be retried
func (p *PushDeliveryLog) IsRetryable() bool {
	return p.StatusCode == 429 || (p.StatusCode >= 500 && p.StatusCode < 600)
}
