//! Real-time notifications over WebSocket (Go: `handlers.NotificationWSHandler`).
//!
//! `GET /api/ws/notifications?token=<jwt>`. Messages are JSON `{"type": .., "payload": ..}`:
//! the server sends `connected`, `pending_delivery` (queued notifications as DTOs),
//! `notification` (the published notification JSON) and `error`; clients may send `pong`.
//! The server pings every 30 s and drops connections that send nothing (data or pong) for 60 s.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::Response;
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use gt_core::constants as c;
use gt_core::extract::QueryParams;
use gt_core::gojson;
use gt_core::jwt::TokenService;
use gt_core::response;
use serde::{Deserialize, Serialize};
use tracing::Instrument;

use super::{fiber, NotifyState};
use crate::dto::notifications_to_dtos;
use crate::json::{go_compact, null_default};
use crate::service::{NotificationService, NotificationSubscription};

/// Message types.
pub const WS_TYPE_NOTIFICATION: &str = "notification";
pub const WS_TYPE_PING: &str = "ping";
pub const WS_TYPE_PONG: &str = "pong";
pub const WS_TYPE_CONNECTED: &str = "connected";
pub const WS_TYPE_ERROR: &str = "error";
pub const WS_TYPE_PENDING_DELIVERY: &str = "pending_delivery";

/// Close code sent when a client message exceeds the read limit (RFC 6455 "message too big").
const CLOSE_MESSAGE_TOO_BIG: u16 = 1009;
const CLOSE_GOING_AWAY: u16 = 1001;
const CLOSE_ABNORMAL: u16 = 1006;
const CLOSE_NO_STATUS: u16 = 1005;

/// Envelope of every WebSocket message (Go: `WSMessage`; `payload` omitted when `None`).
#[derive(Serialize)]
struct WsMessage<'a, P: Serialize + ?Sized> {
    #[serde(rename = "type")]
    msg_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<&'a P>,
}

/// Encodes a WebSocket message like Go's `json.Marshal(WSMessage{..})`.
pub fn encode_message<P: Serialize + ?Sized>(msg_type: &str, payload: Option<&P>) -> serde_json::Result<String> {
    gojson::to_string(&WsMessage { msg_type, payload })
}

/// Wraps a payload received on a notification channel: `{"type":"notification","payload":<raw>}`
/// (Go marshals it as `json.RawMessage`, so it must be valid JSON and is compacted).
pub fn encode_notification_message(raw: &[u8]) -> Option<String> {
    let compact = go_compact(std::str::from_utf8(raw).ok()?)?;
    Some(format!(r#"{{"type":"{WS_TYPE_NOTIFICATION}","payload":{compact}}}"#))
}

#[derive(Serialize)]
struct ConnectedPayload<'a> {
    connection_id: &'a str,
    user_id: i64,
}

#[derive(Deserialize)]
struct ClientMessage {
    #[serde(rename = "type", default, deserialize_with = "null_default")]
    msg_type: String,
}

#[derive(Debug, thiserror::Error)]
enum WsWriteError {
    #[error("websocket connection closed")]
    Closed,
    #[error("i/o timeout")]
    Timeout,
    #[error(transparent)]
    Socket(#[from] axum::Error),
}

/// A client connection. Both the connection's own task and [`NotificationWsHandler::broadcast_to_user`]
/// write to it, one writer at a time. After a failed write or [`WsConn::close`] every write fails.
struct WsConn {
    sink: tokio::sync::Mutex<Option<SplitSink<WebSocket, Message>>>,
}

impl WsConn {
    async fn write(&self, msg: Message) -> Result<(), WsWriteError> {
        let mut guard = self.sink.lock().await;
        let sink = guard.as_mut().ok_or(WsWriteError::Closed)?;
        let result = match tokio::time::timeout(c::WS_WRITE_TIMEOUT, sink.send(msg)).await {
            Ok(result) => result.map_err(WsWriteError::from),
            Err(_) => Err(WsWriteError::Timeout),
        };
        if result.is_err() {
            guard.take();
        }
        result
    }

    async fn write_text(&self, text: String) -> Result<(), WsWriteError> {
        self.write(Message::Text(text.into())).await
    }

    /// Sends frames the protocol queued on its own (the reply to a client's close frame).
    async fn flush(&self) {
        if let Some(sink) = self.sink.lock().await.as_mut() {
            let _ = tokio::time::timeout(c::WS_WRITE_TIMEOUT, sink.flush()).await;
        }
    }

    async fn close(&self) {
        self.sink.lock().await.take();
    }
}

type ConnectionMap = HashMap<i64, HashMap<String, Arc<WsConn>>>;

/// Serves notification WebSockets and tracks this instance's connections.
pub struct NotificationWsHandler {
    notifications: Arc<NotificationService>,
    tokens: Arc<TokenService>,
    connections: RwLock<ConnectionMap>,
    ping_interval: Duration,
    read_timeout: Duration,
}

impl NotificationWsHandler {
    /// Go: `NewNotificationWSHandler`.
    pub fn new(notifications: Arc<NotificationService>, tokens: Arc<TokenService>) -> Self {
        Self {
            notifications,
            tokens,
            connections: RwLock::new(HashMap::new()),
            ping_interval: c::WS_PING_INTERVAL,
            read_timeout: c::WS_READ_TIMEOUT,
        }
    }

    /// Overrides the heartbeat timings (defaults: ping every 30 s, 60 s read timeout); for tests.
    pub fn with_heartbeat(mut self, ping_interval: Duration, read_timeout: Duration) -> Self {
        self.ping_interval = ping_interval;
        self.read_timeout = read_timeout;
        self
    }

    /// Sends a message to every connection of the user on this instance (Go: `BroadcastToUser`).
    /// Connections closing meanwhile are skipped.
    pub async fn broadcast_to_user<P: Serialize + ?Sized>(&self, user_id: i64, msg_type: &str, payload: Option<&P>) {
        let conns: Vec<Arc<WsConn>> = {
            let map = self.connections.read().unwrap_or_else(|e| e.into_inner());
            map.get(&user_id).map(|c| c.values().cloned().collect()).unwrap_or_default()
        };
        if conns.is_empty() {
            return;
        }
        let Ok(data) = encode_message(msg_type, payload) else { return };
        for conn in conns {
            let _ = conn.write_text(data.clone()).await;
        }
    }

    /// Number of this instance's open connections for the user.
    pub fn local_connection_count(&self, user_id: i64) -> usize {
        let map = self.connections.read().unwrap_or_else(|e| e.into_inner());
        map.get(&user_id).map_or(0, HashMap::len)
    }

    fn add_connection(&self, user_id: i64, conn_id: &str, conn: Arc<WsConn>) {
        let mut map = self.connections.write().unwrap_or_else(|e| e.into_inner());
        map.entry(user_id).or_default().insert(conn_id.to_string(), conn);
    }

    fn remove_connection(&self, user_id: i64, conn_id: &str) {
        let mut map = self.connections.write().unwrap_or_else(|e| e.into_inner());
        if let Some(conns) = map.get_mut(&user_id) {
            conns.remove(conn_id);
            if conns.is_empty() {
                map.remove(&user_id);
            }
        }
    }

    /// Runs one upgraded connection until the client leaves (Go: `HandleConnection`).
    async fn serve(self: Arc<Self>, socket: WebSocket, user_id: i64, username: String) {
        let conn_id = uuid::Uuid::new_v4().to_string();
        let span =
            tracing::info_span!("ws", trace_id = %format!("ws-{}", &conn_id[..8]), user_id, username = %username);
        self.run_connection(socket, user_id, conn_id).instrument(span).await;
    }

    async fn run_connection(&self, socket: WebSocket, user_id: i64, conn_id: String) {
        tracing::info!("WebSocket connection initiated");
        let (sink, stream) = socket.split();
        let wc = Arc::new(WsConn { sink: tokio::sync::Mutex::new(Some(sink)) });

        match self.notifications.track_ws_connection(user_id, &conn_id).await {
            Err(err) => {
                tracing::error!(error = %err, "Failed to track WebSocket connection");
                send_message(&wc, WS_TYPE_ERROR, Some("Internal server error")).await;
                return;
            }
            Ok(false) => {
                tracing::warn!("Max WebSocket connections exceeded");
                send_message(&wc, WS_TYPE_ERROR, Some("Maximum connections exceeded. Please close other tabs.")).await;
                return;
            }
            Ok(true) => {}
        }

        self.add_connection(user_id, &conn_id, wc.clone());
        send_message(&wc, WS_TYPE_CONNECTED, Some(&ConnectedPayload { connection_id: &conn_id, user_id })).await;
        self.deliver_pending_notifications(&wc, user_id).await;

        let mut subscription = self.notifications.subscribe_to_notifications(user_id);
        let mut reader = tokio::spawn(read_loop(stream, wc.clone(), self.read_timeout).in_current_span());
        let start = tokio::time::Instant::now() + self.ping_interval;
        let mut ping = tokio::time::interval_at(start, self.ping_interval);

        let mut reader_done = false;
        loop {
            tokio::select! {
                _ = &mut reader => {
                    reader_done = true;
                    break;
                }
                _ = ping.tick() => {
                    if let Err(err) = wc.write(Message::Ping(Bytes::new())).await {
                        tracing::warn!(error = %err, "Failed to send ping");
                        break;
                    }
                    self.notifications.refresh_ws_connection(user_id).await;
                }
                payload = next_published(&mut subscription) => match payload {
                    Some(payload) => forward_published(&wc, &payload).await,
                    None => break,
                },
            }
        }

        drop(subscription);
        if !reader_done {
            reader.abort();
            let _ = reader.await;
        }
        self.remove_connection(user_id, &conn_id);
        wc.close().await;
        self.notifications.remove_ws_connection(user_id, &conn_id).await;
        tracing::info!("WebSocket connection closed");
    }

    /// Sends the notifications queued while the user had no connection.
    async fn deliver_pending_notifications(&self, wc: &WsConn, user_id: i64) {
        let pending = self.notifications.get_pending_notifications(user_id).await;
        if pending.is_empty() {
            return;
        }
        tracing::info!(count = pending.len(), "Delivering pending notifications");
        let data = match encode_message(WS_TYPE_PENDING_DELIVERY, Some(&notifications_to_dtos(&pending))) {
            Ok(data) => data,
            Err(err) => {
                tracing::error!(error = %err, "Failed to marshal pending notifications");
                return;
            }
        };
        if let Err(err) = wc.write_text(data).await {
            tracing::warn!(error = %err, "Failed to send pending notifications");
        }
    }
}

async fn next_published(subscription: &mut Option<NotificationSubscription>) -> Option<Vec<u8>> {
    match subscription {
        Some(sub) => sub.recv().await,
        None => std::future::pending().await,
    }
}

async fn send_message<P: Serialize + ?Sized>(wc: &WsConn, msg_type: &str, payload: Option<&P>) {
    if let Ok(data) = encode_message(msg_type, payload) {
        let _ = wc.write_text(data).await;
    }
}

async fn forward_published(wc: &WsConn, payload: &[u8]) {
    let Some(data) = encode_notification_message(payload) else {
        tracing::error!(error = "invalid JSON payload", "Failed to marshal WebSocket message");
        return;
    };
    if let Err(err) = wc.write_text(data).await {
        tracing::warn!(error = %err, "Failed to send notification via WebSocket");
    }
}

/// Reads client frames until the connection fails, closes or stays silent for `read_timeout`.
async fn read_loop(mut stream: SplitStream<WebSocket>, wc: Arc<WsConn>, read_timeout: Duration) {
    let mut deadline = tokio::time::Instant::now() + read_timeout;
    loop {
        let message = match tokio::time::timeout_at(deadline, stream.next()).await {
            Err(_) | Ok(None) => return,
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(err))) => {
                if is_capacity_error(&err) {
                    let close = CloseFrame { code: CLOSE_MESSAGE_TOO_BIG, reason: "".into() };
                    let _ = wc.write(Message::Close(Some(close))).await;
                }
                return;
            }
        };
        match message {
            Message::Text(text) => {
                deadline = tokio::time::Instant::now() + read_timeout;
                handle_client_message(text.as_bytes());
            }
            Message::Binary(data) => {
                deadline = tokio::time::Instant::now() + read_timeout;
                handle_client_message(&data);
            }
            Message::Pong(_) => deadline = tokio::time::Instant::now() + read_timeout,
            Message::Ping(_) => {}
            Message::Close(frame) => {
                let (code, reason) = frame.map_or((CLOSE_NO_STATUS, String::new()), |f| (f.code, f.reason.to_string()));
                if code != CLOSE_GOING_AWAY && code != CLOSE_ABNORMAL {
                    let detail = if reason.is_empty() { String::new() } else { format!(": {reason}") };
                    tracing::warn!(error = %format!("websocket: close {code}{detail}"), "WebSocket read error");
                }
                wc.flush().await;
                return;
            }
        }
    }
}

/// A client message larger than the read limit.
fn is_capacity_error(err: &axum::Error) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = source {
        if e.to_string().contains("Space limit exceeded") {
            return true;
        }
        source = e.source();
    }
    false
}

fn handle_client_message(message: &[u8]) {
    match serde_json::from_slice::<Option<ClientMessage>>(message) {
        Err(err) => tracing::debug!(error = %err, "Invalid message format"),
        Ok(msg) => {
            let msg_type = msg.map(|m| m.msg_type).unwrap_or_default();
            if msg_type == WS_TYPE_PONG {
                tracing::debug!("Received pong");
            } else {
                tracing::debug!(msg_type = %msg_type, "Unknown message type");
            }
        }
    }
}

// ==================== HTTP entry points ====================

/// Go `tokenContainsValue` on the first header value: comma-separated tokens, case-insensitive.
fn token_contains(value: Option<&HeaderValue>, token: &str) -> bool {
    value
        .map(HeaderValue::as_bytes)
        .map(|v| v.split(|&b| b == b',').any(|t| t.trim_ascii().eq_ignore_ascii_case(token.as_bytes())))
        .unwrap_or(false)
}

/// Why the upgrade middleware rejected a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpgradeDenied {
    NotWebSocket,
    MissingToken,
    InvalidToken,
}

impl UpgradeDenied {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct ErrorBody {
            error: &'static str,
        }
        let message = match self {
            Self::NotWebSocket => return fiber::upgrade_required(),
            Self::MissingToken => "Missing authentication token",
            Self::InvalidToken => "Invalid or expired token",
        };
        response::json_status(StatusCode::UNAUTHORIZED, &ErrorBody { error: message })
    }
}

/// The upgrade middleware (Go: `UpgradeMiddleware`): WebSocket handshake headers, then the
/// `token` query parameter. Returns the authenticated user.
fn authorize_upgrade(
    s: &NotifyState,
    headers: &HeaderMap,
    query: &QueryParams,
) -> Result<(i64, String), UpgradeDenied> {
    let is_upgrade = token_contains(headers.get(axum::http::header::CONNECTION), "upgrade")
        && token_contains(headers.get(axum::http::header::UPGRADE), "websocket");
    if !is_upgrade {
        return Err(UpgradeDenied::NotWebSocket);
    }
    let token = query.get("token");
    if token.is_empty() {
        return Err(UpgradeDenied::MissingToken);
    }
    let claims = s.ws.tokens.parse(token).map_err(|_| UpgradeDenied::InvalidToken)?;
    let user_id = i64::try_from(claims.user_id).map_err(|_| UpgradeDenied::InvalidToken)?;
    Ok((user_id, claims.username))
}

/// `/api/ws/notifications` (any method; the Go middleware runs for every method).
pub(crate) async fn handle_upgrade(
    State(s): State<NotifyState>,
    method: Method,
    headers: HeaderMap,
    query: QueryParams,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let (user_id, username) = match authorize_upgrade(&s, &headers, &query) {
        Ok(user) => user,
        Err(denied) => return denied.into_response(),
    };
    if method != Method::GET && method != Method::HEAD {
        return fiber::method_not_allowed().await;
    }
    let Ok(upgrade) = upgrade else {
        return fiber::upgrade_required();
    };
    let handler = s.ws.clone();
    upgrade
        .max_message_size(c::WS_MAX_MESSAGE_SIZE)
        .max_frame_size(c::WS_MAX_MESSAGE_SIZE)
        .on_upgrade(move |socket| handler.serve(socket, user_id, username))
}

/// Paths below `/api/ws/notifications`: the middleware still runs, then no route matches.
pub(crate) async fn handle_subpath(
    State(s): State<NotifyState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    query: QueryParams,
) -> Response {
    match authorize_upgrade(&s, &headers, &query) {
        Ok(_) => fiber::not_found(&method, &uri),
        Err(denied) => denied.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_encode_like_go() {
        assert_eq!(
            encode_message(WS_TYPE_CONNECTED, Some(&ConnectedPayload { connection_id: "abc", user_id: 7 })).unwrap(),
            r#"{"type":"connected","payload":{"connection_id":"abc","user_id":7}}"#
        );
        assert_eq!(
            encode_message(WS_TYPE_ERROR, Some("Maximum connections exceeded. Please close other tabs.")).unwrap(),
            r#"{"type":"error","payload":"Maximum connections exceeded. Please close other tabs."}"#
        );
        assert_eq!(encode_message::<()>(WS_TYPE_PING, None).unwrap(), r#"{"type":"ping"}"#);
        assert_eq!(
            encode_message(WS_TYPE_ERROR, Some("<b>")).unwrap(),
            r#"{"type":"error","payload":"\u003cb\u003e"}"#
        );
    }

    #[test]
    fn published_payloads_are_wrapped_as_raw_json() {
        assert_eq!(
            encode_notification_message(b"{\"id\": 1, \"title\": \"a<b\"}\n").unwrap(),
            r#"{"type":"notification","payload":{"id":1,"title":"a\u003cb"}}"#
        );
        assert!(encode_notification_message(b"").is_none());
        assert!(encode_notification_message(b"{not json").is_none());
    }

    #[test]
    fn upgrade_header_tokens() {
        let v = |s: &'static str| HeaderValue::from_static(s);
        assert!(token_contains(Some(&v("Upgrade")), "upgrade"));
        assert!(token_contains(Some(&v("keep-alive, Upgrade")), "upgrade"));
        assert!(token_contains(Some(&v("WebSocket")), "websocket"));
        assert!(!token_contains(Some(&v("keep-alive")), "upgrade"));
        assert!(!token_contains(Some(&v("upgrades")), "upgrade"));
        assert!(!token_contains(None, "upgrade"));
    }
}
