//! Chat events through Redis Pub/Sub: a real server, WebSocket clients and the production
//! delivery ([`gt_chat::NotifyRealtime`]).

mod common;

use std::time::Duration;

use common::{create_user, follow, redis_ready, run, send, TestDb, TestUser};
use futures::StreamExt;
use gt_chat::ChatContext;
use redis::AsyncCommands;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as WsMessage;

type WsClient = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_text(ws: &mut WsClient) -> Value {
    loop {
        let msg =
            tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("message in time").unwrap().unwrap();
        if let WsMessage::Text(text) = msg {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

async fn wait_events_subscribed(user_id: i64) {
    let mut conn = gt_core::redis::conn().unwrap();
    for _ in 0..500 {
        let (_, count): (String, i64) = redis::cmd("PUBSUB")
            .arg("NUMSUB")
            .arg(format!("notif:events:{user_id}"))
            .query_async(&mut conn)
            .await
            .unwrap();
        if count > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never subscribed");
}

#[test]
fn chat_events_fan_out_through_redis() {
    run(async {
        let Some(db) = TestDb::new("redis_events").await else { return };
        if !redis_ready().await {
            db.finish().await;
            return;
        }
        let core = common::core(&db.pool);
        let notify = gt_notify::NotifyContext::new(&core);
        let chat = ChatContext::new(&core, &notify);
        let app = gt_chat::routes(&core, &chat).merge(gt_notify::routes(&core, &notify));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = app.clone();
        tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });

        let amy = create_user(&db.pool, "amy").await;
        let ben = create_user(&db.pool, "ben").await;
        let cat = create_user(&db.pool, "cat").await;
        follow(&db.pool, &amy, &ben).await;
        follow(&db.pool, &amy, &cat).await;
        let token = |user: &TestUser| core.tokens.generate(user.id, &user.username).unwrap().token;
        // Leftover connection tracking from earlier runs would count as "online".
        let mut conn = gt_core::redis::conn().unwrap();
        for user in [&amy, &ben, &cat] {
            let _: () = conn.del(format!("notif:ws:conn:{}", user.id)).await.unwrap();
        }

        let connect = |user: &TestUser| {
            let url = format!("ws://{addr}/api/ws/notifications?token={}", token(user));
            async move { tokio_tungstenite::connect_async(url).await.unwrap().0 }
        };
        let mut amy_ws = connect(&amy).await;
        let mut ben_ws = connect(&ben).await;
        assert_eq!(next_text(&mut amy_ws).await["type"], "connected");
        assert_eq!(next_text(&mut ben_ws).await["type"], "connected");
        wait_events_subscribed(amy.id).await;
        wait_events_subscribed(ben.id).await;

        let opened =
            send(&app, "POST", "/api/chats", Some(&token(&amy)), Some(json!({"user_id": ben.id}))).await.json();
        let conversation = opened["conversation"]["id"].as_i64().unwrap();
        let url = format!("/api/chats/{conversation}/messages");
        let res = send(&app, "POST", &url, Some(&token(&amy)), Some(json!({"body": "via redis"}))).await;
        assert_eq!(res.status, 201, "{}", res.body);
        let sent = res.json()["message"].clone();

        for ws in [&mut amy_ws, &mut ben_ws] {
            let event = next_text(ws).await;
            assert_eq!(
                event,
                json!({"type": "chat_message", "payload": {"conversation_id": conversation, "message": sent}})
            );
            assert_eq!(next_text(ws).await["type"], "chat_receipt");
        }

        send(
            &app,
            "POST",
            &format!("/api/chats/{conversation}/typing"),
            Some(&token(&ben)),
            Some(json!({"is_typing": true})),
        )
        .await;
        let typing = next_text(&mut amy_ws).await;
        assert_eq!(typing["payload"], json!({"conversation_id": conversation, "user_id": ben.id, "is_typing": true}));

        // Cat is offline: the message is stored and a push is attempted (no publisher here).
        let opened =
            send(&app, "POST", "/api/chats", Some(&token(&amy)), Some(json!({"user_id": cat.id}))).await.json();
        let to_cat = opened["conversation"]["id"].as_i64().unwrap();
        let res = send(
            &app,
            "POST",
            &format!("/api/chats/{to_cat}/messages"),
            Some(&token(&amy)),
            Some(json!({"body": "you there?"})),
        )
        .await;
        assert_eq!(res.status, 201);
        db.finish().await;
    });
}
