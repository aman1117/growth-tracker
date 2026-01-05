package handlers

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/services"
	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// WSMessage represents a WebSocket message
type WSMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload,omitempty"`
}

// WebSocket message types
const (
	WSTypeNotification    = "notification"
	WSTypePing            = "ping"
	WSTypePong            = "pong"
	WSTypeConnected       = "connected"
	WSTypeError           = "error"
	WSTypePendingDelivery = "pending_delivery"
)

// NotificationWSHandler handles WebSocket connections for real-time notifications
type NotificationWSHandler struct {
	notifSvc *services.NotificationService
	tokenSvc *TokenService

	// Connection management
	mu          sync.RWMutex
	connections map[uint]map[string]*websocket.Conn // userID -> connID -> conn
}

// NewNotificationWSHandler creates a new NotificationWSHandler
func NewNotificationWSHandler(notifSvc *services.NotificationService, tokenSvc *TokenService) *NotificationWSHandler {
	return &NotificationWSHandler{
		notifSvc:    notifSvc,
		tokenSvc:    tokenSvc,
		connections: make(map[uint]map[string]*websocket.Conn),
	}
}

// UpgradeMiddleware checks authentication before WebSocket upgrade
func (h *NotificationWSHandler) UpgradeMiddleware() fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Check if it's a WebSocket upgrade request
		if !websocket.IsWebSocketUpgrade(c) {
			return fiber.ErrUpgradeRequired
		}

		// Get token from query param (WebSocket can't use Authorization header easily)
		token := c.Query("token")
		if token == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "Missing authentication token",
			})
		}

		// Validate token
		claims, err := h.tokenSvc.Parse(token)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "Invalid or expired token",
			})
		}

		// Store user info in locals for the WebSocket handler
		c.Locals("user_id", claims.UserID)
		c.Locals("username", claims.Username)

		return c.Next()
	}
}

// HandleConnection handles WebSocket connections
func (h *NotificationWSHandler) HandleConnection() fiber.Handler {
	return websocket.New(func(c *websocket.Conn) {
		userID := c.Locals("user_id").(uint)
		username := c.Locals("username").(string)
		connID := uuid.New().String()

		log := logger.LogWithFullContext("ws-"+connID[:8], userID, username)
		log.Infow("WebSocket connection initiated")

		ctx := context.Background()

		// Check connection limit
		allowed, err := h.notifSvc.TrackWSConnection(ctx, userID, connID)
		if err != nil {
			log.Errorw("Failed to track WebSocket connection", "error", err)
			h.sendMessage(c, WSTypeError, "Internal server error")
			return
		}
		if !allowed {
			log.Warnw("Max WebSocket connections exceeded")
			h.sendMessage(c, WSTypeError, "Maximum connections exceeded. Please close other tabs.")
			return
		}

		// Register connection locally
		h.addConnection(userID, connID, c)

		// Send connected confirmation
		h.sendMessage(c, WSTypeConnected, map[string]interface{}{
			"connection_id": connID,
			"user_id":       userID,
		})

		// Deliver any pending notifications
		h.deliverPendingNotifications(ctx, c, userID, log)

		// Subscribe to Redis pub/sub for this user
		pubsub := h.notifSvc.SubscribeToNotifications(ctx, userID)
		var pubsubChan <-chan *goredis.Message
		if pubsub != nil {
			pubsubChan = pubsub.Channel()
			defer pubsub.Close()
		}

		// Setup ping ticker for heartbeat
		pingTicker := time.NewTicker(constants.WSPingInterval)
		defer pingTicker.Stop()

		// Cleanup on disconnect
		defer func() {
			h.removeConnection(userID, connID)
			h.notifSvc.RemoveWSConnection(ctx, userID, connID)
			log.Infow("WebSocket connection closed")
		}()

		// Set read deadline and message size limit
		c.SetReadLimit(constants.WSMaxMessageSize)
		c.SetReadDeadline(time.Now().Add(constants.WSReadTimeout))

		// Message handling goroutine
		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				_, message, err := c.ReadMessage()
				if err != nil {
					if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
						log.Warnw("WebSocket read error", "error", err)
					}
					return
				}

				// Reset read deadline on any message
				c.SetReadDeadline(time.Now().Add(constants.WSReadTimeout))

				// Handle incoming messages (mainly pong responses)
				h.handleClientMessage(c, message, log)
			}
		}()

		// Main event loop
		for {
			select {
			case <-done:
				return

			case <-pingTicker.C:
				// Send ping for heartbeat
				c.SetWriteDeadline(time.Now().Add(constants.WSWriteTimeout))
				if err := c.WriteMessage(websocket.PingMessage, nil); err != nil {
					log.Warnw("Failed to send ping", "error", err)
					return
				}
				// Refresh connection tracking TTL
				h.notifSvc.RefreshWSConnection(ctx, userID)

			case msg, ok := <-pubsubChan:
				if !ok {
					return // Channel closed
				}
				// Forward notification from Redis pub/sub to WebSocket
				h.forwardPubSubMessage(c, msg, log)
			}
		}
	}, websocket.Config{
		HandshakeTimeout: 10 * time.Second,
		ReadBufferSize:   1024,
		WriteBufferSize:  1024,
	})
}

// handleClientMessage processes messages from the client
func (h *NotificationWSHandler) handleClientMessage(c *websocket.Conn, message []byte, log *zap.SugaredLogger) {
	var msg WSMessage
	if err := json.Unmarshal(message, &msg); err != nil {
		log.Debugw("Invalid message format", "error", err)
		return
	}

	switch msg.Type {
	case WSTypePong:
		// Client responded to ping - connection is alive
		log.Debugw("Received pong")
	default:
		log.Debugw("Unknown message type", "type", msg.Type)
	}
}

// forwardPubSubMessage forwards a Redis pub/sub message to the WebSocket
func (h *NotificationWSHandler) forwardPubSubMessage(c *websocket.Conn, msg *goredis.Message, log *zap.SugaredLogger) {
	c.SetWriteDeadline(time.Now().Add(constants.WSWriteTimeout))

	// Create WebSocket message wrapper
	// msg.Payload is already the JSON string of the notification
	wsMsg := WSMessage{
		Type:    WSTypeNotification,
		Payload: json.RawMessage(msg.Payload),
	}

	data, err := json.Marshal(wsMsg)
	if err != nil {
		log.Errorw("Failed to marshal WebSocket message", "error", err)
		return
	}

	if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Warnw("Failed to send notification via WebSocket", "error", err)
	}
}

// deliverPendingNotifications sends any pending notifications on reconnect
func (h *NotificationWSHandler) deliverPendingNotifications(ctx context.Context, c *websocket.Conn, userID uint, log *zap.SugaredLogger) {
	pending, err := h.notifSvc.GetPendingNotifications(ctx, userID)
	if err != nil {
		log.Warnw("Failed to get pending notifications", "error", err)
		return
	}

	if len(pending) == 0 {
		return
	}

	log.Infow("Delivering pending notifications", "count", len(pending))

	// Convert to DTOs
	dtos := dto.NotificationsToDTOs(pending)

	wsMsg := WSMessage{
		Type:    WSTypePendingDelivery,
		Payload: dtos,
	}

	data, err := json.Marshal(wsMsg)
	if err != nil {
		log.Errorw("Failed to marshal pending notifications", "error", err)
		return
	}

	c.SetWriteDeadline(time.Now().Add(constants.WSWriteTimeout))
	if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Warnw("Failed to send pending notifications", "error", err)
	}
}

// sendMessage sends a typed message over WebSocket
func (h *NotificationWSHandler) sendMessage(c *websocket.Conn, msgType string, payload interface{}) {
	msg := WSMessage{
		Type:    msgType,
		Payload: payload,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	c.SetWriteDeadline(time.Now().Add(constants.WSWriteTimeout))
	c.WriteMessage(websocket.TextMessage, data)
}

// addConnection adds a WebSocket connection to the local map
func (h *NotificationWSHandler) addConnection(userID uint, connID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.connections[userID] == nil {
		h.connections[userID] = make(map[string]*websocket.Conn)
	}
	h.connections[userID][connID] = conn
}

// removeConnection removes a WebSocket connection from the local map
func (h *NotificationWSHandler) removeConnection(userID uint, connID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if conns, ok := h.connections[userID]; ok {
		delete(conns, connID)
		if len(conns) == 0 {
			delete(h.connections, userID)
		}
	}
}

// BroadcastToUser sends a message to all connections of a user (local instance only)
func (h *NotificationWSHandler) BroadcastToUser(userID uint, msgType string, payload interface{}) {
	h.mu.RLock()
	conns := h.connections[userID]
	h.mu.RUnlock()

	if len(conns) == 0 {
		return
	}

	msg := WSMessage{
		Type:    msgType,
		Payload: payload,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	for _, conn := range conns {
		conn.SetWriteDeadline(time.Now().Add(constants.WSWriteTimeout))
		conn.WriteMessage(websocket.TextMessage, data)
	}
}
