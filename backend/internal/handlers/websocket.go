package handlers

import (
	"context"
	"encoding/json"
	"errors"
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

// Heartbeat timings, variables only so tests can shorten them.
var (
	wsPingInterval = constants.WSPingInterval
	wsReadTimeout  = constants.WSReadTimeout
)

var errWSConnClosed = errors.New("websocket connection closed")

// wsConn is a client connection. A WebSocket connection allows one writer at a time, and both
// the connection's handler and BroadcastToUser write to it, so every write goes through write.
type wsConn struct {
	conn   *websocket.Conn
	mu     sync.Mutex
	closed bool
}

// write sends one message, unless the connection's handler has finished
func (w *wsConn) write(messageType int, data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return errWSConnClosed
	}
	if err := w.conn.SetWriteDeadline(time.Now().Add(constants.WSWriteTimeout)); err != nil {
		return err
	}
	return w.conn.WriteMessage(messageType, data)
}

// close stops all further writes. The handler calls it before it returns, because the
// connection is recycled for another client after that.
func (w *wsConn) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
}

// NotificationWSHandler handles WebSocket connections for real-time notifications
type NotificationWSHandler struct {
	notifSvc *services.NotificationService
	tokenSvc *TokenService

	// Connection management
	mu          sync.RWMutex
	connections map[uint]map[string]*wsConn // userID -> connID -> conn
}

// NewNotificationWSHandler creates a new NotificationWSHandler
func NewNotificationWSHandler(notifSvc *services.NotificationService, tokenSvc *TokenService) *NotificationWSHandler {
	return &NotificationWSHandler{
		notifSvc:    notifSvc,
		tokenSvc:    tokenSvc,
		connections: make(map[uint]map[string]*wsConn),
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
		wc := &wsConn{conn: c}

		log := logger.LogWithFullContext("ws-"+connID[:8], userID, username)
		log.Infow("WebSocket connection initiated")

		ctx := context.Background()

		// Check connection limit
		allowed, err := h.notifSvc.TrackWSConnection(ctx, userID, connID)
		if err != nil {
			log.Errorw("Failed to track WebSocket connection", "error", err)
			h.sendMessage(wc, WSTypeError, "Internal server error")
			return
		}
		if !allowed {
			log.Warnw("Max WebSocket connections exceeded")
			h.sendMessage(wc, WSTypeError, "Maximum connections exceeded. Please close other tabs.")
			return
		}

		// Register connection locally. Cleanup runs before this handler returns and c is
		// recycled: the connection leaves the map and stops accepting writes first.
		h.addConnection(userID, connID, wc)
		defer func() {
			h.removeConnection(userID, connID)
			wc.close()
			h.notifSvc.RemoveWSConnection(ctx, userID, connID)
			log.Infow("WebSocket connection closed")
		}()

		// Send connected confirmation
		h.sendMessage(wc, WSTypeConnected, map[string]interface{}{
			"connection_id": connID,
			"user_id":       userID,
		})

		// Deliver any pending notifications
		h.deliverPendingNotifications(ctx, wc, userID, log)

		// Subscribe to Redis pub/sub for this user
		pubsub := h.notifSvc.SubscribeToNotifications(ctx, userID)
		var pubsubChan <-chan *goredis.Message
		if pubsub != nil {
			pubsubChan = pubsub.Channel()
			defer pubsub.Close()
		}

		// Setup ping ticker for heartbeat
		pingTicker := time.NewTicker(wsPingInterval)
		defer pingTicker.Stop()

		// Set read deadline and message size limit
		c.SetReadLimit(constants.WSMaxMessageSize)
		c.SetReadDeadline(time.Now().Add(wsReadTimeout))
		// Pongs answering our pings also prove the client is alive (browsers answer pings
		// automatically and may never send a data message). Use the underlying connection:
		// c itself is recycled as soon as this handler returns.
		ws := c.Conn
		ws.SetPongHandler(func(string) error {
			return ws.SetReadDeadline(time.Now().Add(wsReadTimeout))
		})

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
				c.SetReadDeadline(time.Now().Add(wsReadTimeout))

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
				if err := wc.write(websocket.PingMessage, nil); err != nil {
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
				h.forwardPubSubMessage(wc, msg, log)
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
func (h *NotificationWSHandler) forwardPubSubMessage(wc *wsConn, msg *goredis.Message, log *zap.SugaredLogger) {
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

	if err := wc.write(websocket.TextMessage, data); err != nil {
		log.Warnw("Failed to send notification via WebSocket", "error", err)
	}
}

// deliverPendingNotifications sends any pending notifications on reconnect
func (h *NotificationWSHandler) deliverPendingNotifications(ctx context.Context, wc *wsConn, userID uint, log *zap.SugaredLogger) {
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

	if err := wc.write(websocket.TextMessage, data); err != nil {
		log.Warnw("Failed to send pending notifications", "error", err)
	}
}

// sendMessage sends a typed message over WebSocket
func (h *NotificationWSHandler) sendMessage(wc *wsConn, msgType string, payload interface{}) {
	msg := WSMessage{
		Type:    msgType,
		Payload: payload,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	_ = wc.write(websocket.TextMessage, data)
}

// addConnection adds a WebSocket connection to the local map
func (h *NotificationWSHandler) addConnection(userID uint, connID string, conn *wsConn) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.connections[userID] == nil {
		h.connections[userID] = make(map[string]*wsConn)
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

// BroadcastToUser sends a message to all connections of a user (local instance only). It is safe
// to call from any goroutine.
func (h *NotificationWSHandler) BroadcastToUser(userID uint, msgType string, payload interface{}) {
	// Copy the user's connections under the read lock: the map changes as clients come and go
	h.mu.RLock()
	conns := make([]*wsConn, 0, len(h.connections[userID]))
	for _, conn := range h.connections[userID] {
		conns = append(conns, conn)
	}
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

	// A connection that closed after the copy refuses the write
	for _, conn := range conns {
		_ = conn.write(websocket.TextMessage, data)
	}
}
