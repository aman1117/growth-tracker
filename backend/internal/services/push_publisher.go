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

	// Async queue for non-blocking publishes
	queue     chan *pushJob
	batchSize int
	batchWait time.Duration
	wg        sync.WaitGroup
	closed    bool
}

// pushJob represents an async publish request
type pushJob struct {
	msg *azservicebus.Message
	ctx context.Context
}

const (
	defaultQueueSize = 1000                   // Buffer up to 1000 messages
	defaultBatchSize = 50                     // Send up to 50 messages per batch
	defaultBatchWait = 100 * time.Millisecond // Max wait before sending partial batch
)

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

	// Configure client with retry options to handle transient failures
	clientOpts := &azservicebus.ClientOptions{
		RetryOptions: azservicebus.RetryOptions{
			MaxRetries:    3,
			RetryDelay:    time.Second,
			MaxRetryDelay: 30 * time.Second,
		},
	}

	client, err := azservicebus.NewClientFromConnectionString(cfg.AzureServiceBus.ConnectionString, clientOpts)
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

	p := &PushPublisher{
		client:    client,
		sender:    sender,
		config:    cfg,
		queue:     make(chan *pushJob, defaultQueueSize),
		batchSize: defaultBatchSize,
		batchWait: defaultBatchWait,
	}

	// Warm up the connection immediately (TLS handshake happens here, not on first message)
	go p.warmupConnection()

	// Start background worker for async publishing
	p.wg.Add(1)
	go p.worker()

	return p, nil
}

// warmupConnection sends a probe to establish the AMQP/TLS connection early
func (p *PushPublisher) warmupConnection() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Create an empty batch just to trigger connection establishment
	// This forces the TLS handshake to happen at startup, not on first notification
	batch, err := p.sender.NewMessageBatch(ctx, nil)
	if err != nil {
		logger.Sugar.Warnw("Failed to warm up Service Bus connection",
			"error", err,
		)
		return
	}
	_ = batch // Just discard it, we only wanted to trigger the connection

	logger.Sugar.Infow("Service Bus connection warmed up")
}

// IsAvailable returns true if the push publisher is properly configured
func (p *PushPublisher) IsAvailable() bool {
	if p == nil {
		return false
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.sender != nil && !p.closed
}

// QueueStats returns the current queue depth for monitoring
func (p *PushPublisher) QueueStats() (pending int, capacity int) {
	if p == nil || p.queue == nil {
		return 0, 0
	}
	return len(p.queue), cap(p.queue)
}

// worker processes the async queue and sends messages in batches
func (p *PushPublisher) worker() {
	defer p.wg.Done()

	batch := make([]*azservicebus.Message, 0, p.batchSize)
	timer := time.NewTimer(p.batchWait)
	defer timer.Stop()

	flush := func() {
		if len(batch) == 0 {
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		p.mu.RLock()
		sender := p.sender
		p.mu.RUnlock()

		if sender == nil {
			logger.Sugar.Warnw("Sender not available, dropping batch",
				"count", len(batch),
			)
			batch = batch[:0]
			return
		}

		// Use batch send for efficiency
		msgBatch, err := sender.NewMessageBatch(ctx, nil)
		if err != nil {
			logger.Sugar.Errorw("Failed to create message batch",
				"error", err,
			)
			batch = batch[:0]
			return
		}

		sent := 0
		for _, msg := range batch {
			if err := msgBatch.AddMessage(msg, nil); err != nil {
				// Batch full, send what we have and retry this message
				if err := sender.SendMessageBatch(ctx, msgBatch, nil); err != nil {
					logger.Sugar.Errorw("Failed to send message batch",
						"error", err,
						"count", sent,
					)
				} else {
					logger.Sugar.Debugw("Sent push notification batch",
						"count", sent,
					)
				}

				// Create new batch for remaining messages
				msgBatch, err = sender.NewMessageBatch(ctx, nil)
				if err != nil {
					logger.Sugar.Errorw("Failed to create new message batch",
						"error", err,
					)
					break
				}
				sent = 0

				// Retry adding this message
				if err := msgBatch.AddMessage(msg, nil); err != nil {
					logger.Sugar.Warnw("Message too large for batch, sending individually",
						"error", err,
					)
					_ = sender.SendMessage(ctx, msg, nil)
				}
			}
			sent++
		}

		// Send remaining messages in batch
		if msgBatch.NumMessages() > 0 {
			if err := sender.SendMessageBatch(ctx, msgBatch, nil); err != nil {
				logger.Sugar.Errorw("Failed to send final message batch",
					"error", err,
					"count", msgBatch.NumMessages(),
				)
			} else {
				logger.Sugar.Debugw("Sent push notification batch",
					"count", msgBatch.NumMessages(),
				)
			}
		}

		batch = batch[:0]
	}

	for {
		select {
		case job, ok := <-p.queue:
			if !ok {
				// Channel closed, flush remaining and exit
				flush()
				return
			}

			batch = append(batch, job.msg)

			// Flush if batch is full
			if len(batch) >= p.batchSize {
				flush()
				timer.Reset(p.batchWait)
			}

		case <-timer.C:
			// Flush partial batch on timeout
			flush()
			timer.Reset(p.batchWait)
		}
	}
}

// Close closes the Service Bus connection
func (p *PushPublisher) Close(ctx context.Context) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true

	// Close the queue to stop the worker
	if p.queue != nil {
		close(p.queue)
	}
	p.mu.Unlock()

	// Wait for worker to finish processing remaining messages
	p.wg.Wait()

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

// PublishPushNotification publishes a push notification message to Service Bus asynchronously.
// This method is non-blocking - it queues the message for background processing.
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

	// Queue for async processing (non-blocking)
	select {
	case p.queue <- &pushJob{msg: sbMessage, ctx: ctx}:
		logger.Sugar.Debugw("Push message queued",
			"message_id", msg.MessageID,
			"user_id", userID,
			"type", notificationType,
		)
	default:
		// Queue is full, log warning but don't block the caller
		logger.Sugar.Warnw("Push notification queue full, message dropped",
			"user_id", userID,
			"type", notificationType,
			"queue_size", len(p.queue),
		)
		return fmt.Errorf("push notification queue full")
	}

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
