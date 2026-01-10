// Package services contains the Service Bus publisher for push notifications.
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/pkg/models"
)

// PushMessage represents a message sent to the push notification queue
type PushMessage struct {
	MessageID        string                 `json:"message_id"`
	UserID           uint                   `json:"user_id"`
	NotificationType string                 `json:"notification_type"`
	Title            string                 `json:"title"`
	Body             string                 `json:"body"`
	DedupeKey        string                 `json:"dedupe_key,omitempty"`
	DeepLink         string                 `json:"deep_link,omitempty"`
	Tag              string                 `json:"tag,omitempty"` // For browser-side collapse
	Data             map[string]interface{} `json:"data,omitempty"`
	TTLSeconds       int                    `json:"ttl_seconds"`
	CreatedAt        time.Time              `json:"created_at"`
}

// PushPublisher handles publishing push notifications to Azure Service Bus
type PushPublisher struct {
	client *azservicebus.Client
	sender *azservicebus.Sender
	config *config.Config
	mu     sync.RWMutex
}

var (
	pushPublisher     *PushPublisher
	pushPublisherOnce sync.Once
)

// InitPushPublisher initializes the global push publisher
func InitPushPublisher(cfg *config.Config) error {
	var initErr error
	pushPublisherOnce.Do(func() {
		pushPublisher, initErr = NewPushPublisher(cfg)
	})
	return initErr
}

// GetPushPublisher returns the global push publisher instance
func GetPushPublisher() *PushPublisher {
	return pushPublisher
}

// NewPushPublisher creates a new PushPublisher
func NewPushPublisher(cfg *config.Config) (*PushPublisher, error) {
	if cfg.AzureServiceBus.ConnectionString == "" {
		logger.Sugar.Warnw("Service Bus not configured, push notifications disabled")
		return &PushPublisher{config: cfg}, nil
	}

	client, err := azservicebus.NewClientFromConnectionString(cfg.AzureServiceBus.ConnectionString, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create Service Bus client: %w", err)
	}

	sender, err := client.NewSender(cfg.AzureServiceBus.QueueName, nil)
	if err != nil {
		client.Close(context.Background())
		return nil, fmt.Errorf("failed to create Service Bus sender: %w", err)
	}

	logger.Sugar.Infow("Push publisher initialized",
		"queue", cfg.AzureServiceBus.QueueName,
	)

	return &PushPublisher{
		client: client,
		sender: sender,
		config: cfg,
	}, nil
}

// IsAvailable returns true if the push publisher is properly configured
func (p *PushPublisher) IsAvailable() bool {
	return p != nil && p.sender != nil
}

// Close closes the Service Bus connection
func (p *PushPublisher) Close(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.sender != nil {
		if err := p.sender.Close(ctx); err != nil {
			logger.Sugar.Warnw("Error closing Service Bus sender", "error", err)
		}
		p.sender = nil
	}

	if p.client != nil {
		if err := p.client.Close(ctx); err != nil {
			logger.Sugar.Warnw("Error closing Service Bus client", "error", err)
		}
		p.client = nil
	}

	return nil
}

// PublishPushNotification publishes a push notification message to Service Bus
func (p *PushPublisher) PublishPushNotification(
	ctx context.Context,
	userID uint,
	notificationType models.NotificationType,
	title, body string,
	dedupeKey string,
	deepLink string,
	data map[string]interface{},
	ttlSeconds int,
) error {
	if !p.IsAvailable() {
		logger.Sugar.Debugw("Push publisher not available, skipping",
			"user_id", userID,
			"type", notificationType,
		)
		return nil
	}

	// Validate deep link
	if deepLink != "" && !isValidDeepLink(deepLink) {
		logger.Sugar.Warnw("Invalid deep link, clearing",
			"deep_link", deepLink,
		)
		deepLink = ""
	}

	// Create message
	msg := PushMessage{
		MessageID:        generateMessageID(),
		UserID:           userID,
		NotificationType: string(notificationType),
		Title:            title,
		Body:             truncateBody(body, 200), // Keep body reasonable
		DedupeKey:        dedupeKey,
		DeepLink:         deepLink,
		Tag:              dedupeKey, // Use dedupe key as collapse tag
		Data:             data,
		TTLSeconds:       ttlSeconds,
		CreatedAt:        time.Now().UTC(),
	}

	// Serialize
	payload, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal push message: %w", err)
	}

	// Validate payload size (max 4KB for Web Push)
	if len(payload) > 4096 {
		logger.Sugar.Warnw("Push payload too large, truncating data",
			"size", len(payload),
			"user_id", userID,
		)
		msg.Data = nil // Remove extra data
		payload, _ = json.Marshal(msg)
	}

	// Create Service Bus message
	sbMessage := &azservicebus.Message{
		Body:      payload,
		MessageID: &msg.MessageID,
		Subject:   (*string)(&msg.NotificationType),
		TimeToLive: func() *time.Duration {
			d := time.Duration(ttlSeconds) * time.Second
			return &d
		}(),
		ApplicationProperties: map[string]interface{}{
			"user_id":    userID,
			"type":       string(notificationType),
			"dedupe_key": dedupeKey,
		},
	}

	// Send to Service Bus
	p.mu.RLock()
	sender := p.sender
	p.mu.RUnlock()

	if sender == nil {
		return fmt.Errorf("sender not available")
	}

	if err := sender.SendMessage(ctx, sbMessage, nil); err != nil {
		logger.Sugar.Errorw("Failed to send push message to Service Bus",
			"user_id", userID,
			"type", notificationType,
			"error", err,
		)
		return fmt.Errorf("failed to send push message: %w", err)
	}

	logger.Sugar.Infow("Push message published to Service Bus",
		"message_id", msg.MessageID,
		"user_id", userID,
		"type", notificationType,
		"dedupe_key", dedupeKey,
	)

	return nil
}

// PublishFromNotification publishes a push notification from a Notification model
func (p *PushPublisher) PublishFromNotification(ctx context.Context, notif *models.Notification, dedupeKey, deepLink string) error {
	// Default TTL: 1 hour for most notifications
	ttl := 3600

	// Extract useful data from metadata and add notification_id
	data := make(map[string]interface{})
	if notif.Metadata != nil {
		data = notif.Metadata
	}
	// Include notification ID so the client can mark it as read when clicked
	data["notification_id"] = notif.ID

	return p.PublishPushNotification(
		ctx,
		notif.UserID,
		notif.Type,
		notif.Title,
		notif.Body,
		dedupeKey,
		deepLink,
		data,
		ttl,
	)
}

// generateMessageID generates a unique message ID
func generateMessageID() string {
	return fmt.Sprintf("push-%d-%d", time.Now().UnixNano(), time.Now().Nanosecond())
}

// isValidDeepLink validates that a deep link is safe
func isValidDeepLink(link string) bool {
	// Must start with / (relative path) or be a well-known pattern
	if strings.HasPrefix(link, "/") {
		return true
	}
	// Block absolute URLs that could be malicious
	return false
}

// truncateBody truncates body text to max length
func truncateBody(body string, maxLen int) string {
	if len(body) <= maxLen {
		return body
	}
	return body[:maxLen-3] + "..."
}
