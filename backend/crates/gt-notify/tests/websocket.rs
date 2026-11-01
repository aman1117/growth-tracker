//! WebSocket notifications end to end: a real server, a WebSocket client and Redis Pub/Sub.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{core, redis_ready, run, token, unique_user_id, TestDb};
use futures::{SinkExt, StreamExt};
use gt_core::gojson;
use gt_notify::{routes, NewNotification, NotificationWsHandler, NotifyContext};
use redis::AsyncCommands;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn serve(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("127.0.0.1:{}", addr.port())
}

async fn next_text(client: &mut Client) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), client.next()).await.expect("message in time");
        match msg.expect("stream open").expect("no error") {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("unexpected message {other:?}"),
        }
    }
}

async fn wait_subscribed(user_id: i64) {
    let mut conn = gt_core::redis::conn().unwrap();
    let channel = format!("notif:channel:{user_id}");
    for _ in 0..500 {
        let (_, count): (String, i64) =
            redis::cmd("PUBSUB").arg("NUMSUB").arg(&channel).query_async(&mut conn).await.unwrap();
        if count > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never subscribed");
}

async fn tracked(user_id: i64) -> i64 {
    let mut conn = gt_core::redis::conn().unwrap();
    conn.scard(format!("notif:ws:conn:{user_id}")).await.unwrap()
}

/// Waits until the server dropped the connection (TCP close, maybe after a close frame).
async fn expect_closed(client: &mut Client) -> Option<CloseFrame> {
    let mut close = None;
    loop {
        match tokio::time::timeout(Duration::from_secs(5), client.next()).await.expect("closed in time") {
            None => return close,
            Some(Ok(Message::Close(frame))) => close = frame,
            Some(Ok(_)) => {}
            Some(Err(_)) => return close,
        }
    }
}

#[test]
fn upgrade_checks_match_go() {
    run(async {
        let Some(db) = TestDb::new("ws_upgrade").await else { return };
        let core = core(&db.pool);
        let addr = serve(routes(&core, &NotifyContext::new(&core))).await;
        let tok = token(&core, unique_user_id());
        let http = reqwest::Client::new();
        let upgrade_headers = |req: reqwest::RequestBuilder| {
            req.header("Connection", "keep-alive, Upgrade")
                .header("Upgrade", "websocket")
                .header("Sec-WebSocket-Version", "13")
                .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        };

        let resp = http.get(format!("http://{addr}/api/ws/notifications?token={tok}")).send().await.unwrap();
        assert_eq!(resp.status(), 426);
        assert_eq!(resp.headers()["content-type"], "text/plain; charset=utf-8");
        assert_eq!(resp.text().await.unwrap(), "Upgrade Required");

        for (query, message) in [("", "Missing authentication token"), ("?token=bogus", "Invalid or expired token")] {
            let resp =
                upgrade_headers(http.get(format!("http://{addr}/api/ws/notifications{query}"))).send().await.unwrap();
            assert_eq!(resp.status(), 401);
            assert_eq!(resp.headers()["content-type"], "application/json");
            assert_eq!(resp.text().await.unwrap(), format!(r#"{{"error":"{message}"}}"#));
        }

        let resp =
            upgrade_headers(http.post(format!("http://{addr}/api/ws/notifications?token={tok}"))).send().await.unwrap();
        assert_eq!(resp.status(), 405);
        assert_eq!(resp.text().await.unwrap(), "Method Not Allowed");
        let resp = http
            .get(format!("http://{addr}/api/ws/notifications?token={tok}"))
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "8")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 426, "handshake failures answer like Fiber's ErrUpgradeRequired");

        let resp = upgrade_headers(http.get(format!("http://{addr}/api/ws/notifications/extra?token={tok}")))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
        assert_eq!(resp.text().await.unwrap(), "Cannot GET /api/ws/notifications/extra");
        let resp = http.get(format!("http://{addr}/api/ws/notifications/extra")).send().await.unwrap();
        assert_eq!(resp.status(), 426, "the upgrade middleware covers sub-paths");

        match tokio_tungstenite::connect_async(format!("ws://{addr}/api/ws/notifications")).await {
            Err(WsError::Http(resp)) => assert_eq!(resp.status(), 401),
            other => panic!("expected a 401, got {other:?}"),
        }
        db.finish().await;
    });
}

#[test]
fn notifications_round_trip() {
    run(async {
        let Some(db) = TestDb::new("ws_round_trip").await else { return };
        if !redis_ready().await {
            db.finish().await;
            return;
        }
        let core = core(&db.pool);
        let notify = NotifyContext::new(&core);
        let addr = serve(routes(&core, &notify)).await;
        let user = unique_user_id();
        let svc = notify.notification_service.clone();

        // A notification queued while the user was offline is delivered on connect.
        let offline =
            svc.repository().create(&NewNotification::new(user, "badge_unlocked", "Badge", "b", None)).await.unwrap();
        let mut conn = gt_core::redis::conn().unwrap();
        let _: () = conn.lpush(format!("notif:pending:{user}"), gojson::to_vec(&offline).unwrap()).await.unwrap();

        let url = format!("ws://{addr}/api/ws/notifications?token={}", token(&core, user));
        let (mut client, resp) = tokio_tungstenite::connect_async(&url).await.unwrap();
        assert_eq!(resp.status(), 101);
        let connected = next_text(&mut client).await;
        assert_eq!(connected["type"], "connected");
        assert_eq!(connected["payload"]["user_id"], user);
        let conn_id = connected["payload"]["connection_id"].as_str().unwrap().to_string();
        assert_eq!(conn_id.len(), 36);
        let pending = next_text(&mut client).await;
        assert_eq!(pending["type"], "pending_delivery");
        assert_eq!(pending["payload"][0]["id"], offline.id);
        assert_eq!(pending["payload"][0]["title"], "Badge");
        assert!(pending["payload"][0].get("read_at").is_none(), "DTOs omit read_at while unread");
        assert_eq!(tracked(user).await, 1);
        assert_eq!(notify.ws_handler.local_connection_count(user), 1);

        // Notifications created now arrive as the published JSON.
        wait_subscribed(user).await;
        let created = svc
            .create(NewNotification::new(
                user,
                "like_received",
                "New Like!",
                "x liked",
                Some(serde_json::json!({"liker_id": 9})),
            ))
            .await
            .unwrap();
        let msg = tokio::time::timeout(Duration::from_secs(5), client.next()).await.unwrap().unwrap().unwrap();
        let Message::Text(text) = msg else { panic!("expected text, got {msg:?}") };
        assert_eq!(
            text.as_str(),
            format!(r#"{{"type":"notification","payload":{}}}"#, gojson::to_string(&created).unwrap())
        );

        // Broadcasts reach every local connection of the user.
        notify.ws_handler.broadcast_to_user(user, "notification", Some(&serde_json::json!({"k": 1}))).await;
        assert_eq!(next_text(&mut client).await, serde_json::json!({"type": "notification", "payload": {"k": 1}}));

        // Client messages are accepted (and ignored) whatever they contain.
        client.send(Message::text(r#"{"type":"pong"}"#)).await.unwrap();
        client.send(Message::text("not json")).await.unwrap();

        // Oversized messages close the connection with 1009.
        client.send(Message::text("x".repeat(600))).await.unwrap();
        let close = expect_closed(&mut client).await.expect("close frame");
        assert_eq!(close.code, CloseCode::Size);
        for _ in 0..100 {
            if tracked(user).await == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(tracked(user).await, 0, "connection untracked after it closed");
        assert_eq!(notify.ws_handler.local_connection_count(user), 0);

        // A normal client close is answered.
        let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        assert_eq!(next_text(&mut client).await["type"], "connected");
        client.close(Some(CloseFrame { code: CloseCode::Normal, reason: "bye".into() })).await.unwrap();
        let reply = expect_closed(&mut client).await.expect("close reply");
        assert_eq!(reply.code, CloseCode::Normal);
        db.finish().await;
    });
}

#[test]
fn connection_limit_heartbeat_and_read_timeout() {
    run(async {
        let Some(db) = TestDb::new("ws_heartbeat").await else { return };
        if !redis_ready().await {
            db.finish().await;
            return;
        }
        let core = core(&db.pool);
        let notify = NotifyContext::new(&core);
        let ws = NotificationWsHandler::new(notify.notification_service.clone(), core.tokens.clone())
            .with_heartbeat(Duration::from_millis(100), Duration::from_millis(1000));
        let notify = notify.with_ws_handler(Arc::new(ws));
        let addr = serve(routes(&core, &notify)).await;
        let user = unique_user_id();
        let url = format!("ws://{addr}/api/ws/notifications?token={}", token(&core, user));

        // Pings keep a silent client alive: the client library answers them with pongs.
        let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        assert_eq!(next_text(&mut client).await["type"], "connected");
        let mut pings = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(1200);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout_at(deadline, client.next()).await {
                Ok(Some(Ok(Message::Ping(_)))) => pings += 1,
                Ok(Some(Ok(other))) => panic!("unexpected {other:?}"),
                Ok(other) => panic!("connection ended: {other:?}"),
                Err(_) => break,
            }
        }
        assert!(pings >= 5, "{pings} pings");

        drop(client);

        // Five tracked connections per user at most, across instances: the count comes from
        // Redis, so other tabs are simulated there.
        let limited = unique_user_id();
        let key = format!("notif:ws:conn:{limited}");
        let mut conn = gt_core::redis::conn().unwrap();
        for i in 0..5 {
            let _: () = conn.sadd(&key, format!("other-tab-{i}")).await.unwrap();
        }
        let _: () = conn.expire(&key, 45).await.unwrap();
        let limited_url = format!("ws://{addr}/api/ws/notifications?token={}", token(&core, limited));
        let (mut sixth, _) = tokio_tungstenite::connect_async(&limited_url).await.unwrap();
        assert_eq!(
            next_text(&mut sixth).await,
            serde_json::json!({"type": "error", "payload": "Maximum connections exceeded. Please close other tabs."})
        );
        assert!(expect_closed(&mut sixth).await.is_none(), "dropped without a close frame, like Go");
        assert_eq!(tracked(limited).await, 5, "a rejected connection is not tracked");
        let _: () = conn.srem(&key, "other-tab-0").await.unwrap();
        let (mut fifth, _) = tokio_tungstenite::connect_async(&limited_url).await.unwrap();
        assert_eq!(next_text(&mut fifth).await["type"], "connected");
        assert_eq!(tracked(limited).await, 5);
        drop(fifth);
        for _ in 0..250 {
            if tracked(limited).await == 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(tracked(limited).await, 4, "closed connections are untracked");
        let _: () = conn.del(&key).await.unwrap();
        // A client that stops reading (and so never answers pings) is dropped after the read timeout.
        let stream = TcpStream::connect(&addr).await.unwrap();
        let (mut silent, _) =
            tokio_tungstenite::client_async(url.clone(), MaybeTlsStream::Plain(stream)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(2500)).await;
        let mut ended = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while let Ok(item) = tokio::time::timeout_at(deadline, silent.next()).await {
            match item {
                None | Some(Err(_)) => {
                    ended = true;
                    break;
                }
                Some(Ok(_)) => {}
            }
        }
        assert!(ended, "server closed the silent connection");
        db.finish().await;
    });
}
