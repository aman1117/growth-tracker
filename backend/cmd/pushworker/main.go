// Package main is the entry point for the Push Notification Worker service.
// This worker consumes messages from Azure Service Bus and delivers Web Push notifications.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/database"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
	"go.uber.org/zap"
	"golang.org/x/time/rate"
)

// Worker handles push notification delivery
type Worker struct {
	cfg         *config.Config
	pushRepo    *repository.PushRepository
	sbClient    *azservicebus.Client
	sbReceiver  *azservicebus.Receiver
	rateLimiter *rate.Limiter
	wg          sync.WaitGroup
	stopCh      chan struct{}
	readyCh     chan struct{}
	isReady     bool
	mu          sync.RWMutex
	msgCh       chan *azservicebus.ReceivedMessage // Channel for distributing messages to workers
}

// NewWorker creates a new push notification worker
func NewWorker(cfg *config.Config, pushRepo *repository.PushRepository) (*Worker, error) {
	// Create Service Bus client
	sbClient, err := azservicebus.NewClientFromConnectionString(cfg.AzureServiceBus.ConnectionString, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create Service Bus client: %w", err)
	}

	// Create receiver
	sbReceiver, err := sbClient.NewReceiverForQueue(cfg.AzureServiceBus.QueueName, nil)
	if err != nil {
		sbClient.Close(context.Background())
		return nil, fmt.Errorf("failed to create Service Bus receiver: %w", err)
	}

	return &Worker{
		cfg:         cfg,
		pushRepo:    pushRepo,
		sbClient:    sbClient,
		sbReceiver:  sbReceiver,
		rateLimiter: rate.NewLimiter(rate.Limit(cfg.PushWorker.SendRateLimit), cfg.PushWorker.SendRateLimit),
		stopCh:      make(chan struct{}),
		readyCh:     make(chan struct{}),
		msgCh:       make(chan *azservicebus.ReceivedMessage, cfg.PushWorker.MaxConcurrent*2), // Buffered channel
	}, nil
}

// Start begins processing messages
func (w *Worker) Start(ctx context.Context) {
	logger.Sugar.Info("Starting push worker...")

	// Mark as ready
	w.mu.Lock()
	w.isReady = true
	w.mu.Unlock()
	close(w.readyCh) // We are not using this for now, but could be useful in future

	// Start the message receiver goroutine (single receiver, distributes to workers via channel)
	w.wg.Add(1)
	go w.receiveLoop(ctx)

	// Start worker goroutines that process messages from the channel
	for i := 0; i < w.cfg.PushWorker.MaxConcurrent; i++ {
		w.wg.Add(1)
		go w.processLoop(ctx, i)
	}

	logger.Sugar.Infow("Push worker started",
		"concurrent_workers", w.cfg.PushWorker.MaxConcurrent,
		"rate_limit", w.cfg.PushWorker.SendRateLimit,
	)
}

// Stop gracefully stops the worker
func (w *Worker) Stop(ctx context.Context) {
	logger.Sugar.Info("Stopping push worker...")

	// Signal workers to stop
	close(w.stopCh)

	// Wait for in-flight work
	done := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		logger.Sugar.Info("All workers stopped gracefully")
	case <-ctx.Done():
		logger.Sugar.Warn("Shutdown timeout, some workers may not have finished")
	}

	// Close Service Bus connections
	if w.sbReceiver != nil {
		w.sbReceiver.Close(ctx)
	}
	if w.sbClient != nil {
		w.sbClient.Close(ctx)
	}

	w.mu.Lock()
	w.isReady = false
	w.mu.Unlock()
}

// IsReady returns true if the worker is ready to process messages
func (w *Worker) IsReady() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.isReady
}

// receiveLoop receives messages from Service Bus and distributes them to workers
func (w *Worker) receiveLoop(ctx context.Context) {
	defer w.wg.Done()
	defer close(w.msgCh) // Close channel when receiver stops

	log := logger.Sugar.With("component", "receiver")
	log.Info("Message receiver started")

	for {
		select {
		case <-w.stopCh:
			log.Info("Receiver stopping")
			return
		case <-ctx.Done():
			log.Info("Receiver context cancelled")
			return
		default:
		}

		// Receive batch of messages
		messages, err := w.sbReceiver.ReceiveMessages(ctx, 10, nil)
		if err != nil {
			if ctx.Err() != nil {
				return // Context cancelled
			}
			log.Warnw("Failed to receive messages", "error", err)
			time.Sleep(time.Second) // Brief backoff
			continue
		}

		// Distribute messages to workers via channel
		for _, msg := range messages {
			select {
			case <-w.stopCh:
				return
			case <-ctx.Done():
				return
			case w.msgCh <- msg:
				// Message sent to worker
			}
		}
	}
}

// processLoop is the main processing loop for a worker goroutine
func (w *Worker) processLoop(ctx context.Context, workerID int) {
	defer w.wg.Done()

	log := logger.Sugar.With("worker_id", workerID)
	log.Info("Worker started")

	for {
		select {
		case <-w.stopCh:
			log.Info("Worker stopping")
			return
		case <-ctx.Done():
			log.Info("Worker context cancelled")
			return
		case msg, ok := <-w.msgCh:
			if !ok {
				log.Info("Message channel closed, worker exiting")
				return
			}
			w.processMessage(ctx, msg, log)
		}
	}
}

// processMessage handles a single push notification message
func (w *Worker) processMessage(ctx context.Context, msg *azservicebus.ReceivedMessage, log *zap.SugaredLogger) {
	var pushMsg services.PushMessage
	if err := json.Unmarshal(msg.Body, &pushMsg); err != nil {
		log.Errorw("Failed to unmarshal message", "error", err)
		// Complete the message to remove from queue (can't process invalid messages)
		w.sbReceiver.CompleteMessage(ctx, msg, nil)
		return
	}

	// Check delivery count - abandon permanently if too many retries
	deliveryCount := msg.DeliveryCount
	if deliveryCount > 5 {
		log.Warnw("Message exceeded max delivery attempts, dead-lettering",
			"message_id", pushMsg.MessageID,
			"delivery_count", deliveryCount,
		)
		// Dead letter the message (or complete to discard)
		w.sbReceiver.CompleteMessage(ctx, msg, nil)
		return
	}

	log = log.With(
		"message_id", pushMsg.MessageID,
		"user_id", pushMsg.UserID,
		"type", pushMsg.NotificationType,
		"delivery_count", deliveryCount,
	)

	log.Infow("Processing push message")

	// 1. Check user preferences
	pref, err := w.pushRepo.GetOrCreatePreference(pushMsg.UserID)
	if err != nil {
		log.Errorw("Failed to get user preferences", "error", err)
		w.sbReceiver.AbandonMessage(ctx, msg, nil)
		return
	}

	if !pref.IsTypeEnabled(pushMsg.NotificationType) {
		log.Infow("Push skipped", "reason", "disabled_by_preference")
		w.sbReceiver.CompleteMessage(ctx, msg, nil)
		return
	}

	// 2. Check quiet hours
	if pref.IsInQuietHours(time.Now()) {
		log.Infow("Push skipped", "reason", "quiet_hours")
		w.sbReceiver.AbandonMessage(ctx, msg, nil)
		return
	}

	// 3. Check server-side dedupe
	if pushMsg.DedupeKey != "" {
		isDupe, err := w.pushRepo.CheckDedupeWindow(pushMsg.UserID, pushMsg.DedupeKey, w.cfg.PushWorker.DedupeWindowSeconds)
		if err != nil {
			log.Warnw("Dedupe check failed", "error", err)
			// Continue anyway
		} else if isDupe {
			log.Infow("Push skipped", "reason", "dedupe")
			w.sbReceiver.CompleteMessage(ctx, msg, nil)
			return
		}
	}

	// 4. Get active subscriptions for user
	subscriptions, err := w.pushRepo.GetActiveSubscriptionsByUserID(pushMsg.UserID)
	if err != nil {
		log.Errorw("Failed to get subscriptions", "error", err)
		w.sbReceiver.AbandonMessage(ctx, msg, nil)
		return
	}

	if len(subscriptions) == 0 {
		log.Infow("No active subscriptions for user")
		w.sbReceiver.CompleteMessage(ctx, msg, nil)
		return
	}

	log.Infow("Sending to subscriptions", "count", len(subscriptions))

	// 5. Send to each subscription
	allSucceeded := true
	for _, sub := range subscriptions {
		success := w.sendToSubscription(ctx, &pushMsg, &sub, log)
		if !success {
			allSucceeded = false
		}
	}

	// 6. Complete or abandon message
	if allSucceeded {
		w.sbReceiver.CompleteMessage(ctx, msg, nil)
	} else {
		// At least one failed with retryable error
		w.sbReceiver.AbandonMessage(ctx, msg, nil)
	}
}

// sendToSubscription sends a push notification to a single subscription
func (w *Worker) sendToSubscription(ctx context.Context, pushMsg *services.PushMessage, sub *models.PushSubscription, log *zap.SugaredLogger) bool {
	log = log.With("subscription_id", sub.ID)

	// Rate limit
	if err := w.rateLimiter.Wait(ctx); err != nil {
		log.Warnw("Rate limiter cancelled", "error", err)
		return false
	}

	// Check idempotency
	alreadySent, err := w.pushRepo.CheckIdempotency(pushMsg.MessageID, sub.ID)
	if err != nil {
		log.Warnw("Idempotency check failed", "error", err)
	} else if alreadySent {
		log.Debugw("Already sent to this subscription, skipping")
		return true
	}

	// Build payload
	payload := buildPushPayload(pushMsg)

	// Send push notification
	start := time.Now()

	resp, err := webpush.SendNotification(payload, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys: webpush.Keys{
			P256dh: sub.P256dh,
			Auth:   sub.Auth,
		},
	}, &webpush.Options{
		Subscriber:      w.cfg.WebPush.VapidSubject,
		VAPIDPublicKey:  w.cfg.WebPush.VapidPublicKey,
		VAPIDPrivateKey: w.cfg.WebPush.VapidPrivateKey,
		TTL:             pushMsg.TTLSeconds,
	})

	duration := time.Since(start)

	// Log delivery attempt
	deliveryLog := &models.PushDeliveryLog{
		UserID:           pushMsg.UserID,
		SubscriptionID:   sub.ID,
		NotificationType: pushMsg.NotificationType,
		DedupeKey:        pushMsg.DedupeKey,
		MessageID:        pushMsg.MessageID,
		DurationMs:       duration.Milliseconds(),
	}

	if err != nil {
		log.Errorw("Failed to send push notification", "error", err)
		deliveryLog.StatusCode = 0
		deliveryLog.Error = err.Error()
		w.pushRepo.CreateDeliveryLog(deliveryLog)
		w.pushRepo.IncrementSubscriptionFailure(sub.ID, 5) // Max 5 failures
		return false
	}

	defer resp.Body.Close()
	statusCode := resp.StatusCode
	deliveryLog.StatusCode = statusCode

	log.Infow("Push response received",
		"status_code", statusCode,
		"duration_ms", duration.Milliseconds(),
	)

	switch {
	case statusCode >= 200 && statusCode < 300:
		// Success
		w.pushRepo.UpdateSubscriptionSuccess(sub.ID)
		w.pushRepo.CreateDeliveryLog(deliveryLog)
		return true

	case statusCode == 404 || statusCode == 410:
		// Subscription is gone - mark as dead
		log.Infow("Subscription gone, marking as dead")
		w.pushRepo.MarkSubscriptionGone(sub.ID)
		deliveryLog.Error = "subscription_gone"
		w.pushRepo.CreateDeliveryLog(deliveryLog)
		return true // Don't retry for this subscription

	case statusCode == 429:
		// Rate limited - retry later
		log.Warnw("Rate limited by push service")
		deliveryLog.Error = "rate_limited"
		w.pushRepo.CreateDeliveryLog(deliveryLog)
		return false

	case statusCode >= 500:
		// Server error - retry
		log.Warnw("Push service server error", "status_code", statusCode)
		deliveryLog.Error = fmt.Sprintf("server_error_%d", statusCode)
		w.pushRepo.CreateDeliveryLog(deliveryLog)
		return false

	default:
		// Other client error (400, 401, 403, etc.)
		log.Errorw("Push client error", "status_code", statusCode)
		deliveryLog.Error = fmt.Sprintf("client_error_%d", statusCode)
		w.pushRepo.CreateDeliveryLog(deliveryLog)
		w.pushRepo.IncrementSubscriptionFailure(sub.ID, 5)
		return true // Don't retry, likely auth/encryption issue
	}
}

// buildPushPayload creates the JSON payload for the push notification
func buildPushPayload(msg *services.PushMessage) []byte {
	payload := map[string]interface{}{
		"type":     msg.NotificationType,
		"title":    msg.Title,
		"body":     msg.Body,
		"tag":      msg.Tag,
		"deepLink": msg.DeepLink,
		"data":     msg.Data,
	}
	data, _ := json.Marshal(payload)
	return data
}

func main() {
	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		panic("Failed to load configuration: " + err.Error())
	}

	// Initialize logger
	logger.Init(cfg)
	defer logger.Sync()

	log := logger.Sugar

	// Validate required config
	if cfg.AzureServiceBus.ConnectionString == "" {
		log.Fatal("AZURE_SERVICEBUS_CONNECTION_STRING is required")
	}
	if cfg.WebPush.VapidPublicKey == "" || cfg.WebPush.VapidPrivateKey == "" {
		log.Fatal("VAPID keys are required")
	}

	// Initialize database
	db, err := database.Init(&cfg.Database)
	if err != nil {
		log.Fatalf("Database connection failed: %v", err)
	}
	log.Info("Database connection established")

	// Run migrations
	if err := database.AutoMigrate(); err != nil {
		log.Fatalf("Database migration failed: %v", err)
	}
	log.Info("Database migrations completed")

	// Create repository
	pushRepo := repository.NewPushRepository(db)

	// Create worker
	worker, err := NewWorker(cfg, pushRepo)
	if err != nil {
		log.Fatalf("Failed to create worker: %v", err)
	}

	// Start health server
	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
	})

	// Health endpoints
	app.Get("/healthz", func(c *fiber.Ctx) error {
		return c.SendString("OK")
	})

	app.Get("/readyz", func(c *fiber.Ctx) error {
		if worker.IsReady() {
			return c.SendString("OK")
		}
		return c.Status(503).SendString("Not Ready")
	})

	// Start HTTP server
	port := cfg.Server.Port
	if port == "" {
		port = "8001"
	}
	go func() {
		if err := app.Listen(":" + port); err != nil {
			log.Fatalf("Health server failed: %v", err)
		}
	}()
	log.Infow("Health server started", "port", port)

	// Start worker
	ctx, cancel := context.WithCancel(context.Background())
	worker.Start(ctx)

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Info("Shutdown signal received")

	// Graceful shutdown
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	cancel() // Cancel worker context
	worker.Stop(shutdownCtx)

	if err := app.Shutdown(); err != nil {
		log.Warnw("Error shutting down health server", "error", err)
	}

	log.Info("Push worker shutdown complete")
}
