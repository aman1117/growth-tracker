package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
	fws "github.com/fasthttp/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const wsPath = "/api/ws/notifications"

// ==================== WebSocket harness ====================

// mountWSRoutes mounts h the way routes.go does.
func mountWSRoutes(app *fiber.App, h *NotificationWSHandler) {
	api := app.Group("/api")
	api.Use("/ws/notifications", h.UpgradeMiddleware())
	api.Get("/ws/notifications", h.HandleConnection())
}

// trackingListener counts accepted connections until the server closes them. fasthttp closes
// a hijacked (WebSocket) connection only after the handler has returned, so a count of zero
// means every server-side handler, including its deferred clean-up, has finished.
type trackingListener struct {
	net.Listener
	open atomic.Int64
}

func (l *trackingListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	l.open.Add(1)
	return &trackedConn{Conn: conn, closed: func() { l.open.Add(-1) }}, nil
}

type trackedConn struct {
	net.Conn
	once   sync.Once
	closed func()
}

func (c *trackedConn) Close() error {
	c.once.Do(c.closed)
	return c.Conn.Close()
}

// wsServer serves the notification WebSocket endpoint on a random localhost port.
type wsServer struct {
	h        *NotificationWSHandler
	tokenSvc *TokenService
	addr     string
	ln       *trackingListener
}

// startWSServer must be called after testutil.StartRedis and observeLogs: clean-ups run in
// reverse order, so the clients are closed, the handlers finish and the server shuts down
// before Redis and the logger are torn down.
func startWSServer(t *testing.T, env *testEnv) *wsServer {
	t.Helper()
	h := NewNotificationWSHandler(env.notifSvc, env.tokenSvc)
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	mountWSRoutes(app, h)

	inner, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	ln := &trackingListener{Listener: inner}
	served := make(chan error, 1)
	go func() { served <- app.Listener(ln) }()

	srv := &wsServer{h: h, tokenSvc: env.tokenSvc, addr: inner.Addr().String(), ln: ln}
	t.Cleanup(func() {
		srv.waitHandlersDone(t)
		assert.NoError(t, app.Shutdown())
		_ = inner.Close() // in case Shutdown ran before Serve registered the listener
		select {
		case err := <-served:
			assert.NoError(t, err)
		case <-time.After(5 * time.Second):
			t.Error("WebSocket test server did not stop")
		}
	})
	return srv
}

// waitHandlersDone waits until every server-side connection has been closed.
func (s *wsServer) waitHandlersDone(t *testing.T) {
	t.Helper()
	eventually(t, func() bool { return s.ln.open.Load() == 0 }, "WebSocket handlers still running")
}

func (s *wsServer) token(t *testing.T, user *models.User) string {
	t.Helper()
	token, _, _, err := s.tokenSvc.Generate(user)
	require.NoError(t, err)
	return token
}

// dial opens a WebSocket to the notifications endpoint; token "" omits the query parameter.
// The client connection is closed when the (sub)test ends.
func (s *wsServer) dial(t *testing.T, token string) (*fws.Conn, *http.Response, error) {
	t.Helper()
	target := url.URL{Scheme: "ws", Host: s.addr, Path: wsPath}
	if token != "" {
		target.RawQuery = url.Values{"token": {token}}.Encode()
	}
	dialer := fws.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, resp, err := dialer.Dial(target.String(), nil)
	if conn != nil {
		t.Cleanup(func() { _ = conn.Close() })
	}
	return conn, resp, err
}

// connect opens an authenticated connection for user, reads the "connected" greeting and
// returns the connection with its server-assigned id.
func (s *wsServer) connect(t *testing.T, user *models.User) (*fws.Conn, string) {
	t.Helper()
	conn, resp, err := s.dial(t, s.token(t, user))
	require.NoError(t, err)
	assert.Equal(t, http.StatusSwitchingProtocols, resp.StatusCode)

	msg := readWS(t, conn)
	require.Equal(t, WSTypeConnected, msg.Type, "first message")
	var greeting struct {
		ConnectionID string `json:"connection_id"`
		UserID       uint   `json:"user_id"`
	}
	require.NoError(t, json.Unmarshal(msg.Payload, &greeting))
	assert.Equal(t, user.ID, greeting.UserID)
	_, err = uuid.Parse(greeting.ConnectionID)
	require.NoError(t, err, "connection_id is a UUID")
	return conn, greeting.ConnectionID
}

// connIDs lists the connections the handler has registered locally for userID.
func (s *wsServer) connIDs(userID uint) []string {
	s.h.mu.RLock()
	defer s.h.mu.RUnlock()
	ids := []string{}
	for id := range s.h.connections[userID] {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

type wsEnvelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// readWS reads the next message, failing instead of blocking when none arrives.
func readWS(t *testing.T, conn *fws.Conn) wsEnvelope {
	t.Helper()
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(5*time.Second)))
	typ, data, err := conn.ReadMessage()
	require.NoError(t, err)
	assert.Equal(t, fws.TextMessage, typ)
	var msg wsEnvelope
	require.NoError(t, json.Unmarshal(data, &msg), "message %s", data)
	return msg
}

// readClosed reads until the server ends the connection and returns the read error.
func readClosed(t *testing.T, conn *fws.Conn) error {
	t.Helper()
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(5*time.Second)))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			var netErr net.Error
			require.False(t, errors.As(err, &netErr) && netErr.Timeout(), "the server did not close the connection")
			return err
		}
	}
}

func sendWS(t *testing.T, conn *fws.Conn, message string) {
	t.Helper()
	require.NoError(t, conn.WriteMessage(fws.TextMessage, []byte(message)))
}

func wsConnKey(userID uint) string { return constants.NotifWSConnPrefix + itoa(userID) }

func wsChannel(userID uint) string { return constants.NotifChannelPrefix + itoa(userID) }

// trackedConnIDs returns the connection ids tracked in Redis for userID. It does not fail the
// test, so it can be polled from eventually.
func trackedConnIDs(mr *miniredis.Miniredis, userID uint) []string {
	ids, err := mr.SMembers(wsConnKey(userID))
	if err != nil { // miniredis.ErrKeyNotFound once the last connection is removed
		return []string{}
	}
	return ids
}

// waitSubscribed waits until n connections of userID listen on the user's pub/sub channel:
// go-redis subscribes asynchronously, and PUBLISH drops messages nobody listens to.
func waitSubscribed(t *testing.T, mr *miniredis.Miniredis, userID uint, n int) {
	t.Helper()
	channel := wsChannel(userID)
	eventually(t, func() bool { return mr.PubSubNumSub(channel)[channel] == n }, "subscribers of %s", channel)
}

// useWSTimings shortens the heartbeat for one test. Call it before startWSServer, so the
// handlers have stopped by the time the defaults are restored.
func useWSTimings(t *testing.T, pingInterval, readTimeout time.Duration) {
	t.Helper()
	prevPing, prevRead := wsPingInterval, wsReadTimeout
	wsPingInterval, wsReadTimeout = pingInterval, readTimeout
	t.Cleanup(func() { wsPingInterval, wsReadTimeout = prevPing, prevRead })
}

// ==================== Handshake ====================

func TestNotificationWSHandler_RejectsRequestsWithoutUpgrade(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	h := NewNotificationWSHandler(env.notifSvc, env.tokenSvc)
	app := fiber.New()
	mountWSRoutes(app, h)
	token, _, _, err := env.tokenSvc.Generate(user)
	require.NoError(t, err)

	for _, method := range []string{http.MethodGet, http.MethodPost} {
		res := testutil.Do(t, app, method, wsPath+"?token="+token, nil)
		assert.Equal(t, fiber.StatusUpgradeRequired, res.Status, method)
		assert.Equal(t, "Upgrade Required", string(res.Body), method)
	}
	assert.Empty(t, h.connections)
}

func TestNotificationWSHandler_RejectsMissingOrInvalidTokens(t *testing.T) {
	env := newEnv(t)
	srv := startWSServer(t, env)
	user := env.user(t)

	expired, _, _, err := newTestTokenService(testutil.JWTSecret, -time.Minute).Generate(user)
	require.NoError(t, err)
	foreign, _, _, err := newTestTokenService("some-other-secret", time.Hour).Generate(user)
	require.NoError(t, err)

	tests := []struct {
		name, token, message string
	}{
		{"missing token", "", "Missing authentication token"},
		{"garbage token", "not-a-jwt", "Invalid or expired token"},
		{"expired token", expired, "Invalid or expired token"},
		{"token signed with another secret", foreign, "Invalid or expired token"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			conn, resp, err := srv.dial(t, tc.token)

			require.ErrorIs(t, err, fws.ErrBadHandshake)
			assert.Nil(t, conn)
			require.NotNil(t, resp)
			assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
			body, err := io.ReadAll(resp.Body)
			require.NoError(t, err)
			assert.JSONEq(t, `{"error":"`+tc.message+`"}`, string(body))
		})
	}
	assert.Empty(t, srv.connIDs(user.ID))
}

// ==================== Connection lifecycle ====================

func TestNotificationWSHandler_TracksConnectionAndCleansUp(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	logs := observeLogs(t)
	srv := startWSServer(t, env)
	user := env.user(t)

	conn, connID := srv.connect(t, user)

	assert.Equal(t, []string{connID}, srv.connIDs(user.ID))
	assert.Equal(t, []string{connID}, trackedConnIDs(mr, user.ID))
	assert.Equal(t, constants.NotifWSConnTTL, mr.TTL(wsConnKey(user.ID)))
	waitSubscribed(t, mr, user.ID, 1)
	assert.Zero(t, logs.FilterMessage("Delivering pending notifications").Len(), "nothing was pending")

	require.NoError(t, conn.Close())
	srv.waitHandlersDone(t)

	assert.Empty(t, srv.connIDs(user.ID))
	assert.Empty(t, trackedConnIDs(mr, user.ID))
	waitSubscribed(t, mr, user.ID, 0)
	closed := logs.FilterMessage("WebSocket connection closed").All()
	require.Len(t, closed, 1)
	assert.Equal(t, "ws-"+connID[:8], closed[0].ContextMap()["trace_id"])
	assert.EqualValues(t, user.ID, closed[0].ContextMap()["user_id"])
	assert.Equal(t, user.Username, closed[0].ContextMap()["username"])
	assert.Zero(t, logs.FilterMessage("WebSocket read error").Len(), "a dropped connection is an expected close")
}

func TestNotificationWSHandler_Disconnects(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	logs := observeLogs(t)
	srv := startWSServer(t, env)
	user := env.user(t)

	closeWith := func(code int) func(*testing.T, *fws.Conn) {
		return func(t *testing.T, conn *fws.Conn) {
			require.NoError(t, conn.WriteControl(fws.CloseMessage, fws.FormatCloseMessage(code, "bye"), time.Now().Add(time.Second)))
		}
	}
	tests := []struct {
		name       string
		disconnect func(*testing.T, *fws.Conn)
		quiet      bool // expected closes must not be logged as read errors
	}{
		{"connection dropped", func(t *testing.T, conn *fws.Conn) { require.NoError(t, conn.Close()) }, true},
		{"client going away", closeWith(fws.CloseGoingAway), true},
		{"normal closure", closeWith(fws.CloseNormalClosure), false},
		{"message over the size limit", func(t *testing.T, conn *fws.Conn) {
			sendWS(t, conn, `{"type":"pong","payload":"`+strings.Repeat("x", constants.WSMaxMessageSize)+`"}`)
			err := readClosed(t, conn)
			assert.True(t, fws.IsCloseError(err, fws.CloseMessageTooBig), "close error: %v", err)
		}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			logs.TakeAll()
			conn, _ := srv.connect(t, user)

			tc.disconnect(t, conn)
			srv.waitHandlersDone(t)

			assert.Empty(t, srv.connIDs(user.ID))
			assert.Empty(t, trackedConnIDs(mr, user.ID))
			assert.Equal(t, 1, logs.FilterMessage("WebSocket connection closed").Len())
			if tc.quiet {
				assert.Zero(t, logs.FilterMessage("WebSocket read error").Len())
			}
		})
	}
}

func TestNotificationWSHandler_LimitsConnectionsPerUser(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	logs := observeLogs(t)
	srv := startWSServer(t, env)
	user := env.user(t)

	conns := make([]*fws.Conn, constants.WSMaxConnsPerUser)
	ids := make([]string, constants.WSMaxConnsPerUser)
	for i := range conns {
		conns[i], ids[i] = srv.connect(t, user)
	}
	sort.Strings(ids)
	assert.Equal(t, ids, srv.connIDs(user.ID))
	assert.Equal(t, ids, trackedConnIDs(mr, user.ID))

	// One more tab is told why and disconnected without being registered.
	extra, _, err := srv.dial(t, srv.token(t, user))
	require.NoError(t, err)
	msg := readWS(t, extra)
	assert.Equal(t, WSTypeError, msg.Type)
	assert.JSONEq(t, `"Maximum connections exceeded. Please close other tabs."`, string(msg.Payload))
	readClosed(t, extra)
	assert.Equal(t, ids, srv.connIDs(user.ID))
	assert.Equal(t, ids, trackedConnIDs(mr, user.ID))
	assert.Equal(t, 1, logs.FilterMessage("Max WebSocket connections exceeded").Len())

	// The limit is per user.
	srv.connect(t, env.user(t))

	// Closing a tab frees a slot.
	require.NoError(t, conns[0].Close())
	eventually(t, func() bool { return len(trackedConnIDs(mr, user.ID)) == constants.WSMaxConnsPerUser-1 })
	srv.connect(t, user)
	assert.Len(t, srv.connIDs(user.ID), constants.WSMaxConnsPerUser)
}

func TestNotificationWSHandler_ConnectionTrackingFailure(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	logs := observeLogs(t)
	srv := startWSServer(t, env)
	user := env.user(t)

	for _, cmd := range []string{"SCARD", "SADD"} {
		t.Run(cmd+" fails", func(t *testing.T) {
			logs.TakeAll()
			failRedisCommand(mr, cmd, constants.NotifWSConnPrefix)
			t.Cleanup(func() { mr.Server().SetPreHook(nil) })

			conn, _, err := srv.dial(t, srv.token(t, user))
			require.NoError(t, err)

			msg := readWS(t, conn)
			assert.Equal(t, WSTypeError, msg.Type)
			assert.JSONEq(t, `"Internal server error"`, string(msg.Payload))
			readClosed(t, conn)
			assert.Empty(t, srv.connIDs(user.ID))
			assert.Equal(t, 1, logs.FilterMessage("Failed to track WebSocket connection").Len())
		})
	}
}

func TestNotificationWSHandler_WorksWithoutRedis(t *testing.T) {
	require.False(t, redis.IsAvailable())
	env := newEnv(t)
	logs := observeLogs(t)
	srv := startWSServer(t, env)
	user := env.user(t)

	conn, connID := srv.connect(t, user)
	assert.Equal(t, []string{connID}, srv.connIDs(user.ID))

	sendWS(t, conn, `{"type":"pong"}`)
	waitLog(t, logs, "Received pong")

	srv.h.BroadcastToUser(user.ID, WSTypeNotification, map[string]string{"title": "local"})
	msg := readWS(t, conn)
	assert.Equal(t, WSTypeNotification, msg.Type)
	assert.JSONEq(t, `{"title":"local"}`, string(msg.Payload))

	require.NoError(t, conn.Close())
	srv.waitHandlersDone(t)
	assert.Empty(t, srv.connIDs(user.ID))
	assert.Equal(t, 1, logs.FilterMessage("WebSocket connection closed").Len())
}

// ==================== Messages ====================

func TestNotificationWSHandler_DeliversPendingNotificationsOnConnect(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	logs := observeLogs(t)
	srv := startWSServer(t, env)
	user := env.user(t)

	readAt := time.Date(2026, 1, 5, 12, 30, 0, 0, time.UTC)
	first := models.Notification{ID: 11, UserID: user.ID, Type: models.NotifTypeLikeReceived, Title: "New like",
		Body: "bob liked your day", Metadata: models.NotificationMetadata{"liker_id": 7},
		CreatedAt: time.Date(2026, 1, 5, 10, 0, 0, 0, time.UTC)}
	second := models.Notification{ID: 12, UserID: user.ID, Type: models.NotifTypeNewFollower, Title: "New follower",
		Body: "carol followed you", ReadAt: &readAt, CreatedAt: time.Date(2026, 1, 5, 11, 0, 0, 0, time.UTC)}
	// The service LPUSHes and GetPendingNotifications RPOPs: the oldest entry comes first and
	// entries that are not notifications are skipped.
	key := constants.NotifPendingPrefix + itoa(user.ID)
	for _, entry := range []string{string(mustJSON(t, first)), "{not json", string(mustJSON(t, second))} {
		_, err := mr.Lpush(key, entry)
		require.NoError(t, err)
	}

	conn, _ := srv.connect(t, user)

	msg := readWS(t, conn)
	assert.Equal(t, WSTypePendingDelivery, msg.Type)
	assert.JSONEq(t, `[
		{"id":11,"type":"like_received","title":"New like","body":"bob liked your day",
		 "metadata":{"liker_id":7},"created_at":"2026-01-05T10:00:00Z"},
		{"id":12,"type":"new_follower","title":"New follower","body":"carol followed you",
		 "read_at":"2026-01-05T12:30:00Z","created_at":"2026-01-05T11:00:00Z"}
	]`, string(msg.Payload))
	assert.False(t, mr.Exists(key), "the queue is drained")
	delivering := logs.FilterMessage("Delivering pending notifications").All()
	require.Len(t, delivering, 1)
	assert.EqualValues(t, 2, delivering[0].ContextMap()["count"])
}

func TestNotificationWSHandler_ForwardsPublishedNotifications(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	logs := observeLogs(t)
	srv := startWSServer(t, env)
	alice := env.user(t)
	bob := env.user(t)

	aliceConn, _ := srv.connect(t, alice)
	bobConn, _ := srv.connect(t, bob)
	waitSubscribed(t, mr, alice.ID, 1)
	waitSubscribed(t, mr, bob.ID, 1)

	ctx := context.Background()
	created := &models.Notification{UserID: alice.ID, Type: models.NotifTypeNewFollower, Title: "New follower",
		Body: "bob followed you", Metadata: models.NotificationMetadata{"follower_id": bob.ID}}
	require.NoError(t, env.notifSvc.Create(ctx, created))

	msg := readWS(t, aliceConn)
	assert.Equal(t, WSTypeNotification, msg.Type)
	var got models.Notification
	require.NoError(t, json.Unmarshal(msg.Payload, &got))
	assert.Equal(t, created.ID, got.ID)
	assert.Equal(t, alice.ID, got.UserID)
	assert.Equal(t, models.NotifTypeNewFollower, got.Type)
	assert.Equal(t, "New follower", got.Title)
	assert.Equal(t, "bob followed you", got.Body)
	assert.EqualValues(t, bob.ID, got.Metadata["follower_id"])

	// A payload that is not JSON cannot be wrapped: it is logged and dropped, and later
	// notifications still arrive.
	assert.Equal(t, 1, mr.Publish(wsChannel(alice.ID), "not json"))
	assert.Equal(t, 1, mr.Publish(wsChannel(alice.ID), `{"id":99,"title":"raw"}`))
	msg = readWS(t, aliceConn)
	assert.Equal(t, WSTypeNotification, msg.Type)
	assert.JSONEq(t, `{"id":99,"title":"raw"}`, string(msg.Payload))
	assert.Equal(t, 1, logs.FilterMessage("Failed to marshal WebSocket message").Len())

	// Each user only receives their own notifications.
	require.NoError(t, env.notifSvc.Create(ctx, &models.Notification{UserID: bob.ID,
		Type: models.NotifTypeSystemAnnounce, Title: "For bob", Body: "hello"}))
	msg = readWS(t, bobConn)
	require.Equal(t, WSTypeNotification, msg.Type)
	var forBob models.Notification
	require.NoError(t, json.Unmarshal(msg.Payload, &forBob))
	assert.Equal(t, bob.ID, forBob.UserID)
	assert.Equal(t, "For bob", forBob.Title)
}

func TestNotificationWSHandler_HandlesClientMessages(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	logs := observeLogs(t)
	srv := startWSServer(t, env)
	user := env.user(t)
	conn, connID := srv.connect(t, user)

	sendWS(t, conn, `{"type":"pong"}`)
	sendWS(t, conn, `{"type":"subscribe","payload":{"channel":"other"}}`)
	sendWS(t, conn, `not json`)

	// Messages are handled in order, so the last log implies the others.
	waitLog(t, logs, "Invalid message format")
	assert.Equal(t, 1, logs.FilterMessage("Received pong").Len())
	unknown := logs.FilterMessage("Unknown message type").All()
	require.Len(t, unknown, 1)
	assert.Equal(t, "subscribe", unknown[0].ContextMap()["type"])

	// Client messages never close the connection.
	waitSubscribed(t, mr, user.ID, 1)
	mr.Publish(wsChannel(user.ID), `{"id":1}`)
	assert.Equal(t, WSTypeNotification, readWS(t, conn).Type)
	assert.Equal(t, []string{connID}, srv.connIDs(user.ID))
}

func TestNotificationWSHandler_BroadcastToUser(t *testing.T) {
	env := newEnv(t)
	srv := startWSServer(t, env)
	alice := env.user(t)
	bob := env.user(t)

	alice1, _ := srv.connect(t, alice)
	alice2, _ := srv.connect(t, alice)
	bobConn, _ := srv.connect(t, bob)

	srv.h.BroadcastToUser(alice.ID, "custom", map[string]string{"k": "v"})
	for _, conn := range []*fws.Conn{alice1, alice2} {
		msg := readWS(t, conn)
		assert.Equal(t, "custom", msg.Type)
		assert.JSONEq(t, `{"k":"v"}`, string(msg.Payload))
	}

	// Payloads that cannot be encoded and users without connections are ignored.
	srv.h.BroadcastToUser(alice.ID, "custom", func() {})
	srv.h.BroadcastToUser(deletedUserID, "custom", "nobody")
	srv.h.BroadcastToUser(alice.ID, "custom", "next")
	srv.h.BroadcastToUser(bob.ID, "custom", "for bob")
	for _, conn := range []*fws.Conn{alice1, alice2} {
		assert.JSONEq(t, `"next"`, string(readWS(t, conn).Payload))
	}
	assert.JSONEq(t, `"for bob"`, string(readWS(t, bobConn).Payload), "bob only receives his own broadcasts")
}

func TestNotificationWSHandler_BroadcastToUser_WhileConnectionsChange(t *testing.T) {
	env := newEnv(t)
	srv := startWSServer(t, env)
	user := env.user(t)
	conn, connID := srv.connect(t, user)
	srv.h.mu.RLock()
	serverConn := srv.h.connections[user.ID][connID]
	srv.h.mu.RUnlock()

	var received atomic.Int64
	require.NoError(t, conn.SetReadDeadline(time.Time{}))
	go func() { // drains the client until the connection is closed at the end of the test
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
			received.Add(1)
		}
	}()

	// Tabs connecting and disconnecting change the user's connection map during broadcasts.
	// Iterating it without the lock trips the runtime's "concurrent map iteration and map
	// write" check (a fatal error, not a test failure).
	const rounds = 2000
	stop, churned := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(churned)
		ids := [...]string{"tab-1", "tab-2", "tab-3", "tab-4"}
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			srv.h.addConnection(user.ID, ids[i%len(ids)], serverConn)
			srv.h.removeConnection(user.ID, ids[i%len(ids)])
		}
	}()
	for i := 0; i < rounds; i++ {
		srv.h.BroadcastToUser(user.ID, "custom", i)
	}
	close(stop)
	<-churned

	assert.Equal(t, []string{connID}, srv.connIDs(user.ID))
	eventually(t, func() bool { return received.Load() >= rounds }, "every broadcast reached the connection")
}

func TestNotificationWSHandler_PongsKeepAnIdleConnectionOpen(t *testing.T) {
	const readTimeout = 250 * time.Millisecond
	useWSTimings(t, readTimeout/10, readTimeout)
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	srv := startWSServer(t, env)
	user := env.user(t)
	conn, connID := srv.connect(t, user)

	// Like a browser, the client answers every ping with a pong (from its read loop) and never
	// sends a data message.
	var pings atomic.Int32
	conn.SetPingHandler(func(data string) error {
		pings.Add(1)
		return conn.WriteControl(fws.PongMessage, []byte(data), time.Now().Add(time.Second))
	})
	require.NoError(t, conn.SetReadDeadline(time.Time{}))
	messages, closed := make(chan wsEnvelope, 10), make(chan error, 1)
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				closed <- err
				return
			}
			var msg wsEnvelope
			if json.Unmarshal(data, &msg) == nil {
				messages <- msg
			}
		}
	}()

	select {
	case err := <-closed:
		t.Fatalf("the server dropped an idle connection that answers pings: %v", err)
	case <-time.After(4 * readTimeout):
	}
	assert.GreaterOrEqual(t, pings.Load(), int32(8), "pings kept coming")
	assert.Equal(t, []string{connID}, srv.connIDs(user.ID))

	// Every ping also refreshes the connection's tracking TTL in Redis.
	mr.FastForward(constants.NotifWSConnTTL - time.Second)
	eventually(t, func() bool { return mr.TTL(wsConnKey(user.ID)) == constants.NotifWSConnTTL }, "tracking TTL refreshed")

	// And the connection still delivers notifications.
	waitSubscribed(t, mr, user.ID, 1)
	mr.Publish(wsChannel(user.ID), `{"id":1}`)
	select {
	case msg := <-messages:
		assert.Equal(t, WSTypeNotification, msg.Type)
		assert.JSONEq(t, `{"id":1}`, string(msg.Payload))
	case err := <-closed:
		t.Fatalf("connection closed: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("no notification received")
	}
}
