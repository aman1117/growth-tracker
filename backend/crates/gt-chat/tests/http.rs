//! The chat API end to end through its routes (no Redis in this binary: events go to the
//! recorder, or to local WebSocket connections in the last test).

mod common;

use std::time::Duration;

use common::{broken_pool, create_user, follow, pair, post_message, run, send, unfollow, Recorder, Stack, TestDb};
use futures::StreamExt;
use gt_chat::ChatContext;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as WsMessage;

fn ids(messages: &Value) -> Vec<i64> {
    messages.as_array().unwrap().iter().map(|m| m["id"].as_i64().unwrap()).collect()
}

#[test]
fn opening_conversations_checks_permission_and_is_idempotent() {
    run(async {
        let Some(db) = TestDb::new("open").await else { return };
        let stack = Stack::new(&db.pool);
        let app = stack.router();
        let amy = create_user(&db.pool, "amy").await;
        let ben = create_user(&db.pool, "ben").await;
        let cat = create_user(&db.pool, "cat").await;
        let amy_token = stack.token(&amy);

        send(&app, "GET", "/api/chats", None, None).await.assert_error(401, "MISSING_AUTH_HEADER");
        send(&app, "POST", "/api/chats", Some(&amy_token), Some(json!({}))).await.assert_error(400, "INVALID_REQUEST");
        send(&app, "POST", "/api/chats", Some(&amy_token), Some(json!({"user_id": "x"})))
            .await
            .assert_error(400, "INVALID_REQUEST");
        send(&app, "POST", "/api/chats", Some(&amy_token), Some(json!({"user_id": amy.id})))
            .await
            .assert_error(400, "CANNOT_MESSAGE_SELF");
        send(&app, "POST", "/api/chats", Some(&amy_token), Some(json!({"user_id": 999_999})))
            .await
            .assert_error(404, "USER_NOT_FOUND");
        send(&app, "POST", "/api/chats", Some(&amy_token), Some(json!({"user_id": ben.id})))
            .await
            .assert_error(403, "CHAT_NOT_ALLOWED");

        // Either follow direction allows messaging.
        follow(&db.pool, &ben, &amy).await;
        let res = send(&app, "POST", "/api/chats", Some(&amy_token), Some(json!({"user_id": ben.id}))).await;
        assert_eq!(res.status, 200, "{}", res.body);
        let created = res.json();
        assert_eq!(created["created"], true);
        let conversation = &created["conversation"];
        let id = conversation["id"].as_i64().unwrap();
        assert_eq!(
            conversation["peer"],
            json!({"id": ben.id, "username": "ben", "profile_pic": "https://cdn.example/ben_thumb.jpg", "is_verified": true})
        );
        assert_eq!(conversation["last_message"], Value::Null);
        assert_eq!(conversation["unread_count"], 0);
        assert_eq!(conversation["can_message"], true);
        assert!(conversation["created_at"].as_str().unwrap().ends_with('Z'));

        let again = send(&app, "POST", "/api/chats", Some(&amy_token), Some(json!({"user_id": ben.id}))).await.json();
        assert_eq!((again["created"].as_bool(), again["conversation"]["id"].as_i64()), (Some(false), Some(id)));
        let ben_side =
            send(&app, "POST", "/api/chats", Some(&stack.token(&ben)), Some(json!({"user_id": amy.id}))).await.json();
        assert_eq!(ben_side["conversation"]["id"], id);
        assert_eq!(ben_side["conversation"]["peer"]["username"], "amy");

        // Concurrent opens resolve to one conversation.
        follow(&db.pool, &amy, &cat).await;
        let svc = stack.chat.chat_service.clone();
        let (a, b) = tokio::join!(svc.open_conversation(amy.id, cat.id), svc.open_conversation(cat.id, amy.id));
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.0.id, b.0.id);
        assert!(a.1 ^ b.1, "exactly one call created it");
        assert_eq!(db.scalar("SELECT count(*) FROM chat_conversations").await, 2);
        assert_eq!(db.scalar("SELECT count(*) FROM chat_members").await, 4);

        // Conversations without messages are not listed.
        let inbox = send(&app, "GET", "/api/chats", Some(&amy_token), None).await.json();
        assert_eq!(inbox, json!({"success": true, "conversations": [], "next_cursor": null, "has_more": false}));
        db.finish().await;
    });
}

#[test]
fn sending_messages_validates_dedupes_and_notifies() {
    run(async {
        let Some(db) = TestDb::new("send").await else { return };
        let stack = Stack::new(&db.pool);
        let app = stack.router();
        let p = pair(&db, &stack).await;
        let url = format!("/api/chats/{}/messages", p.conversation_id);

        for (body, code) in [
            (json!({"body": "  \n "}), "MESSAGE_EMPTY"),
            (json!({"body": "x".repeat(4001)}), "MESSAGE_TOO_LONG"),
            (json!({"body": "hi", "client_message_id": "has space"}), "INVALID_REQUEST"),
            (json!({"body": 5}), "INVALID_REQUEST"),
            (json!({"body": "hi", "reply_to_message_id": 12345}), "REPLY_TARGET_NOT_FOUND"),
            (json!({"body": "hi", "reply_to_message_id": -1}), "REPLY_TARGET_NOT_FOUND"),
        ] {
            send(&app, "POST", &url, Some(&p.amy_token), Some(body)).await.assert_error(400, code);
        }
        send(&app, "POST", "/api/chats/0/messages", Some(&p.amy_token), Some(json!({"body": "hi"})))
            .await
            .assert_error(400, "INVALID_REQUEST");
        send(&app, "POST", "/api/chats/999/messages", Some(&p.amy_token), Some(json!({"body": "hi"})))
            .await
            .assert_error(404, "CONVERSATION_NOT_FOUND");
        let stranger = create_user(&db.pool, "zed").await;
        send(&app, "POST", &url, Some(&stack.token(&stranger)), Some(json!({"body": "hi"})))
            .await
            .assert_error(404, "CONVERSATION_NOT_FOUND");
        assert!(stack.recorder.take_events().is_empty());

        // Sent: trimmed, echoed client id, events for both members and a push for the offline peer.
        let first = post_message(
            &stack,
            &p.amy_token,
            p.conversation_id,
            json!({"body": "  hey ben <3  ", "client_message_id": "c-1"}),
        )
        .await;
        assert_eq!(first["body"], "hey ben <3");
        assert_eq!(first["sender_id"], p.amy.id);
        assert_eq!(first["client_message_id"], "c-1");
        assert_eq!(first["reply_to"], Value::Null);
        assert_eq!(first["reactions"], json!([]));
        assert_eq!(first["is_deleted"], false);
        let first_id = first["id"].as_i64().unwrap();
        let events = stack.recorder.take_events();
        let kinds: Vec<(i64, &str)> = events.iter().map(|(u, k, _)| (*u, k.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                (p.amy.id, "chat_message"),
                (p.ben.id, "chat_message"),
                (p.amy.id, "chat_receipt"),
                (p.ben.id, "chat_receipt")
            ]
        );
        assert_eq!(events[1].2, json!({"conversation_id": p.conversation_id, "message": first}));
        assert_eq!(
            events[3].2,
            json!({"conversation_id": p.conversation_id, "user_id": p.amy.id, "last_read_message_id": first_id, "last_delivered_message_id": first_id})
        );
        let pushes = stack.recorder.take_pushes();
        assert_eq!(pushes.len(), 1);
        let push = &pushes[0];
        assert_eq!(
            (push.user_id, push.notification_type.as_str(), push.title.as_str()),
            (p.ben.id, "chat_message", "amy")
        );
        assert_eq!(push.body, "hey ben <3");
        assert_eq!(push.deep_link, format!("/chats/{}", p.conversation_id));
        assert_eq!(push.dedupe_key, format!("chat:{}:{first_id}", p.conversation_id));
        assert_eq!(push.data.as_ref().unwrap()["sender_username"], "amy");

        // A retry with the same client id returns the stored message (200) without side effects.
        let retry = send(
            &app,
            "POST",
            &url,
            Some(&p.amy_token),
            Some(json!({"body": "hey ben <3", "client_message_id": "c-1"})),
        )
        .await;
        assert_eq!(retry.status, 200, "{}", retry.body);
        assert_eq!(retry.json()["message"], first);
        assert!(stack.recorder.take_events().is_empty());
        assert!(stack.recorder.take_pushes().is_empty());

        // Replies quote the original; connected peers get no push.
        stack.recorder.set_connected(p.amy.id);
        let reply = post_message(
            &stack,
            &p.ben_token,
            p.conversation_id,
            json!({"body": "hi!", "reply_to_message_id": first_id}),
        )
        .await;
        assert_eq!(
            reply["reply_to"],
            json!({"id": first_id, "sender_id": p.amy.id, "body": "hey ben <3", "is_deleted": false})
        );
        assert_eq!(reply["client_message_id"], Value::Null);
        assert!(stack.recorder.take_pushes().is_empty());

        // The same client id in another conversation is a conflict.
        let cat = create_user(&db.pool, "cat").await;
        follow(&db.pool, &p.amy, &cat).await;
        let other = send(&app, "POST", "/api/chats", Some(&p.amy_token), Some(json!({"user_id": cat.id}))).await.json();
        let other_id = other["conversation"]["id"].as_i64().unwrap();
        send(
            &app,
            "POST",
            &format!("/api/chats/{other_id}/messages"),
            Some(&p.amy_token),
            Some(json!({"body": "x", "client_message_id": "c-1"})),
        )
        .await
        .assert_error(409, "CONFLICT");
        // Replies only quote messages of the same conversation.
        send(
            &app,
            "POST",
            &format!("/api/chats/{other_id}/messages"),
            Some(&p.amy_token),
            Some(json!({"body": "x", "reply_to_message_id": first_id})),
        )
        .await
        .assert_error(400, "REPLY_TARGET_NOT_FOUND");

        // Concurrent retries with one client id store a single message.
        let svc = stack.chat.chat_service.clone();
        let req = gt_chat::dto::SendMessageRequest {
            body: "dup".into(),
            client_message_id: Some("c-dup".into()),
            reply_to_message_id: None,
        };
        let viewer = gt_chat::service::Viewer { id: p.amy.id, username: "amy" };
        let (a, b) = tokio::join!(
            svc.send_message(viewer, p.conversation_id, &req),
            svc.send_message(viewer, p.conversation_id, &req)
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.0.id, b.0.id);
        assert!(a.1 ^ b.1, "exactly one call created it");
        assert_eq!(db.scalar("SELECT count(*) FROM chat_messages WHERE client_message_id = 'c-dup'").await, 1);
        db.finish().await;
    });
}

#[test]
fn messages_page_in_both_directions() {
    run(async {
        let Some(db) = TestDb::new("paging").await else { return };
        let stack = Stack::new(&db.pool);
        let app = stack.router();
        let p = pair(&db, &stack).await;
        let mut sent = Vec::new();
        for i in 0..5 {
            let token = if i % 2 == 0 { &p.amy_token } else { &p.ben_token };
            sent.push(
                post_message(&stack, token, p.conversation_id, json!({"body": format!("m{i}")})).await["id"]
                    .as_i64()
                    .unwrap(),
            );
        }
        let url = format!("/api/chats/{}/messages", p.conversation_id);

        let newest = send(&app, "GET", &format!("{url}?limit=2"), Some(&p.ben_token), None).await.json();
        assert_eq!(ids(&newest["messages"]), sent[3..5].to_vec(), "newest page, oldest first");
        assert_eq!(newest["has_more"], true);
        let older =
            send(&app, "GET", &format!("{url}?limit=2&before={}", sent[3]), Some(&p.ben_token), None).await.json();
        assert_eq!(ids(&older["messages"]), sent[1..3].to_vec());
        assert_eq!(older["has_more"], true);
        let oldest =
            send(&app, "GET", &format!("{url}?limit=2&before={}", sent[1]), Some(&p.ben_token), None).await.json();
        assert_eq!((ids(&oldest["messages"]), oldest["has_more"].as_bool()), (vec![sent[0]], Some(false)));
        let all = send(&app, "GET", &url, Some(&p.ben_token), None).await.json();
        assert_eq!((ids(&all["messages"]), all["has_more"].as_bool()), (sent.clone(), Some(false)));

        let newer =
            send(&app, "GET", &format!("{url}?after={}&limit=3", sent[0]), Some(&p.ben_token), None).await.json();
        assert_eq!((ids(&newer["messages"]), newer["has_more"].as_bool()), (sent[1..4].to_vec(), Some(true)));
        let rest = send(&app, "GET", &format!("{url}?after={}", sent[3]), Some(&p.ben_token), None).await.json();
        assert_eq!((ids(&rest["messages"]), rest["has_more"].as_bool()), (vec![sent[4]], Some(false)));
        let from_start = send(&app, "GET", &format!("{url}?after=0"), Some(&p.ben_token), None).await.json();
        assert_eq!(ids(&from_start["messages"]), sent);

        for query in ["?before=1&after=2", "?before=x", "?after=-1", "?limit=0", "?limit=abc"] {
            send(&app, "GET", &format!("{url}{query}"), Some(&p.ben_token), None)
                .await
                .assert_error(400, "INVALID_REQUEST");
        }
        send(&app, "GET", "/api/chats/abc/messages", Some(&p.ben_token), None)
            .await
            .assert_error(400, "INVALID_REQUEST");
        let zed = create_user(&db.pool, "zed").await;
        send(&app, "GET", &url, Some(&stack.token(&zed)), None).await.assert_error(404, "CONVERSATION_NOT_FOUND");
        db.finish().await;
    });
}

#[test]
fn inbox_unread_receipts_and_delivery() {
    run(async {
        let Some(db) = TestDb::new("inbox").await else { return };
        let stack = Stack::new(&db.pool);
        let app = stack.router();
        let p = pair(&db, &stack).await;
        let m1 =
            post_message(&stack, &p.amy_token, p.conversation_id, json!({"body": "one"})).await["id"].as_i64().unwrap();
        let m2 =
            post_message(&stack, &p.amy_token, p.conversation_id, json!({"body": "two"})).await["id"].as_i64().unwrap();
        stack.recorder.take_events();

        let unread = send(&app, "GET", "/api/chats/unread-count", Some(&p.ben_token), None).await.json();
        assert_eq!(unread, json!({"success": true, "unread_conversations": 1, "unread_messages": 2}));
        let own = send(&app, "GET", "/api/chats/unread-count", Some(&p.amy_token), None).await.json();
        assert_eq!(own["unread_messages"], 0, "own messages are never unread");

        // Listing delivers: ben's delivered pointer moves and amy is told.
        let inbox = send(&app, "GET", "/api/chats", Some(&p.ben_token), None).await.json();
        let row = &inbox["conversations"][0];
        assert_eq!(row["peer"]["username"], "amy");
        assert_eq!(row["last_message"]["body"], "two");
        assert_eq!(row["unread_count"], 2);
        assert_eq!(row["my_last_read_message_id"], 0);
        assert_eq!(row["peer_last_read_message_id"], m2);
        let receipts = stack.recorder.take_events();
        assert_eq!(receipts.len(), 2);
        assert_eq!(
            receipts[0].2,
            json!({"conversation_id": p.conversation_id, "user_id": p.ben.id, "last_read_message_id": 0, "last_delivered_message_id": m2})
        );
        send(&app, "GET", "/api/chats", Some(&p.ben_token), None).await;
        assert!(stack.recorder.take_events().is_empty(), "already delivered");
        let amy_view =
            send(&app, "GET", &format!("/api/chats/{}", p.conversation_id), Some(&p.amy_token), None).await.json();
        assert_eq!(amy_view["conversation"]["peer_last_delivered_message_id"], m2);
        assert_eq!(amy_view["conversation"]["peer_last_read_message_id"], 0);

        // Read pointers are clamped and monotonic.
        let read_url = format!("/api/chats/{}/read", p.conversation_id);
        let res = send(&app, "POST", &read_url, Some(&p.ben_token), Some(json!({"message_id": m1}))).await.json();
        assert_eq!(res, json!({"success": true, "last_read_message_id": m1}));
        assert_eq!(
            stack.recorder.take_kinds(),
            vec![(p.amy.id, "chat_receipt".into()), (p.ben.id, "chat_receipt".into())]
        );
        let res =
            send(&app, "POST", &read_url, Some(&p.ben_token), Some(json!({"message_id": m2 + 1000}))).await.json();
        assert_eq!(res["last_read_message_id"], m2);
        let res = send(&app, "POST", &read_url, Some(&p.ben_token), Some(json!({"message_id": m1}))).await.json();
        assert_eq!(res["last_read_message_id"], m2, "never moves back");
        stack.recorder.take_events();
        let res = send(&app, "POST", &read_url, Some(&p.ben_token), Some(json!({"message_id": m2}))).await.json();
        assert_eq!(res["last_read_message_id"], m2);
        assert!(stack.recorder.take_events().is_empty(), "no event without a change");
        send(&app, "POST", &read_url, Some(&p.ben_token), Some(json!({"message_id": 0})))
            .await
            .assert_error(400, "INVALID_REQUEST");
        send(&app, "POST", &read_url, Some(&p.ben_token), Some(json!([]))).await.assert_error(400, "INVALID_REQUEST");
        let unread = send(&app, "GET", "/api/chats/unread-count", Some(&p.ben_token), None).await.json();
        assert_eq!(unread["unread_messages"], 0);

        // Delivered alone.
        let m3 = post_message(&stack, &p.amy_token, p.conversation_id, json!({"body": "three"})).await["id"]
            .as_i64()
            .unwrap();
        let delivered_url = format!("/api/chats/{}/delivered", p.conversation_id);
        let res = send(&app, "POST", &delivered_url, Some(&p.ben_token), Some(json!({"message_id": m3}))).await.json();
        assert_eq!(res, json!({"success": true, "last_delivered_message_id": m3}));
        let res = send(&app, "POST", &delivered_url, Some(&p.ben_token), Some(json!({"message_id": m1}))).await.json();
        assert_eq!(res["last_delivered_message_id"], m3);
        send(&app, "POST", &delivered_url, Some(&p.ben_token), Some(json!({"message_id": -4})))
            .await
            .assert_error(400, "INVALID_REQUEST");
        send(&app, "POST", "/api/chats/x/delivered", Some(&p.ben_token), Some(json!({"message_id": 1})))
            .await
            .assert_error(400, "INVALID_REQUEST");
        let ben_view =
            send(&app, "GET", &format!("/api/chats/{}", p.conversation_id), Some(&p.ben_token), None).await.json();
        assert_eq!(ben_view["conversation"]["unread_count"], 1);
        assert_eq!(ben_view["conversation"]["my_last_read_message_id"], m2);

        // Replying reads everything before it.
        post_message(&stack, &p.ben_token, p.conversation_id, json!({"body": "ok"})).await;
        let unread = send(&app, "GET", "/api/chats/unread-count", Some(&p.ben_token), None).await.json();
        assert_eq!(unread["unread_messages"], 0);
        db.finish().await;
    });
}

#[test]
fn inbox_paginates_by_latest_activity() {
    run(async {
        let Some(db) = TestDb::new("inbox_pages").await else { return };
        let stack = Stack::new(&db.pool);
        let app = stack.router();
        let amy = create_user(&db.pool, "amy").await;
        let token = stack.token(&amy);
        let mut conversations = Vec::new();
        for name in ["ben", "cat", "dan"] {
            let other = create_user(&db.pool, name).await;
            follow(&db.pool, &amy, &other).await;
            let res = send(&app, "POST", "/api/chats", Some(&token), Some(json!({"user_id": other.id}))).await.json();
            let id = res["conversation"]["id"].as_i64().unwrap();
            post_message(&stack, &token, id, json!({"body": format!("to {name}")})).await;
            conversations.push(id);
        }
        // Writing to the oldest conversation moves it to the top.
        post_message(&stack, &token, conversations[0], json!({"body": "again"})).await;

        let first = send(&app, "GET", "/api/chats?limit=2", Some(&token), None).await.json();
        let page_ids: Vec<i64> =
            first["conversations"].as_array().unwrap().iter().map(|c| c["id"].as_i64().unwrap()).collect();
        assert_eq!(page_ids, vec![conversations[0], conversations[2]]);
        assert_eq!(first["has_more"], true);
        let cursor = first["next_cursor"].as_str().unwrap().to_string();
        let second = send(&app, "GET", &format!("/api/chats?limit=2&cursor={cursor}"), Some(&token), None).await.json();
        let page_ids: Vec<i64> =
            second["conversations"].as_array().unwrap().iter().map(|c| c["id"].as_i64().unwrap()).collect();
        assert_eq!(page_ids, vec![conversations[1]]);
        assert_eq!((second["has_more"].as_bool(), &second["next_cursor"]), (Some(false), &Value::Null));
        for query in ["?cursor=nope", "?limit=-2", "?cursor=1_0"] {
            send(&app, "GET", &format!("/api/chats{query}"), Some(&token), None)
                .await
                .assert_error(400, "INVALID_REQUEST");
        }
        let capped = send(&app, "GET", "/api/chats?limit=500", Some(&token), None).await.json();
        assert_eq!(capped["conversations"].as_array().unwrap().len(), 3);
        db.finish().await;
    });
}

#[test]
fn reactions_unsend_and_typing() {
    run(async {
        let Some(db) = TestDb::new("reactions").await else { return };
        let stack = Stack::new(&db.pool);
        let app = stack.router();
        let p = pair(&db, &stack).await;
        let msg = post_message(&stack, &p.amy_token, p.conversation_id, json!({"body": "react to me"})).await;
        let id = msg["id"].as_i64().unwrap();
        let reaction_url = format!("/api/chats/{}/messages/{id}/reaction", p.conversation_id);
        stack.recorder.take_events();

        let res = send(&app, "PUT", &reaction_url, Some(&p.ben_token), Some(json!({"emoji": "❤️"}))).await;
        assert_eq!(res.status, 200, "{}", res.body);
        assert_eq!(
            res.json(),
            json!({"success": true, "message_id": id, "reactions": [{"user_id": p.ben.id, "emoji": "❤️"}]})
        );
        let events = stack.recorder.take_events();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].2,
            json!({"conversation_id": p.conversation_id, "message_id": id, "reactions": [{"user_id": p.ben.id, "emoji": "❤️"}]})
        );
        send(&app, "PUT", &reaction_url, Some(&p.amy_token), Some(json!({"emoji": "😂"}))).await;
        let replaced = send(&app, "PUT", &reaction_url, Some(&p.ben_token), Some(json!({"emoji": "👍🏽"}))).await.json();
        assert_eq!(
            replaced["reactions"],
            json!([{"user_id": p.amy.id, "emoji": "😂"}, {"user_id": p.ben.id, "emoji": "👍🏽"}]),
            "one reaction per user, replacing moves it last"
        );
        for emoji in ["", "ok", "👍 👍"] {
            send(&app, "PUT", &reaction_url, Some(&p.ben_token), Some(json!({"emoji": emoji})))
                .await
                .assert_error(400, "INVALID_REACTION");
        }
        send(
            &app,
            "PUT",
            &format!("/api/chats/{}/messages/99999/reaction", p.conversation_id),
            Some(&p.ben_token),
            Some(json!({"emoji": "👍"})),
        )
        .await
        .assert_error(404, "MESSAGE_NOT_FOUND");
        send(
            &app,
            "PUT",
            &format!("/api/chats/{}/messages/x/reaction", p.conversation_id),
            Some(&p.ben_token),
            Some(json!({"emoji": "👍"})),
        )
        .await
        .assert_error(400, "INVALID_REQUEST");
        let listed = send(&app, "GET", &format!("/api/chats/{}/messages", p.conversation_id), Some(&p.amy_token), None)
            .await
            .json();
        assert_eq!(listed["messages"][0]["reactions"].as_array().unwrap().len(), 2);

        stack.recorder.take_events();
        let removed = send(&app, "DELETE", &reaction_url, Some(&p.amy_token), None).await.json();
        assert_eq!(removed["reactions"], json!([{"user_id": p.ben.id, "emoji": "👍🏽"}]));
        assert_eq!(stack.recorder.take_events().len(), 2);
        let again = send(&app, "DELETE", &reaction_url, Some(&p.amy_token), None).await.json();
        assert_eq!(again["reactions"], removed["reactions"]);
        assert!(stack.recorder.take_events().is_empty(), "idempotent without events");
        send(
            &app,
            "DELETE",
            &format!("/api/chats/{}/messages/99999/reaction", p.conversation_id),
            Some(&p.amy_token),
            None,
        )
        .await
        .assert_error(404, "MESSAGE_NOT_FOUND");

        // Typing reaches only the other member.
        let typing_url = format!("/api/chats/{}/typing", p.conversation_id);
        let res = send(&app, "POST", &typing_url, Some(&p.amy_token), Some(json!({"is_typing": true}))).await;
        assert_eq!(res.json(), json!({"success": true}));
        let events = stack.recorder.take_events();
        assert_eq!(
            events,
            vec![(
                p.ben.id,
                "chat_typing".to_string(),
                json!({"conversation_id": p.conversation_id, "user_id": p.amy.id, "is_typing": true})
            )]
        );
        send(&app, "POST", &typing_url, Some(&p.amy_token), Some(json!({"is_typing": "yes"})))
            .await
            .assert_error(400, "INVALID_REQUEST");

        // Only the sender can unsend; unsending clears body and reactions, everywhere.
        let reply = post_message(
            &stack,
            &p.ben_token,
            p.conversation_id,
            json!({"body": "quoting", "reply_to_message_id": id}),
        )
        .await;
        stack.recorder.take_events();
        let unsend_url = format!("/api/chats/{}/messages/{id}", p.conversation_id);
        send(&app, "DELETE", &unsend_url, Some(&p.ben_token), None).await.assert_error(403, "MESSAGE_FORBIDDEN");
        let res = send(&app, "DELETE", &unsend_url, Some(&p.amy_token), None).await.json();
        let unsent = &res["message"];
        assert_eq!(
            (unsent["is_deleted"].as_bool(), unsent["body"].as_str(), unsent["reactions"].as_array().map(Vec::len)),
            (Some(true), Some(""), Some(0))
        );
        let events = stack.recorder.take_events();
        assert_eq!(
            events.iter().map(|(_, k, _)| k.as_str()).collect::<Vec<_>>(),
            vec!["chat_message_deleted", "chat_message_deleted"]
        );
        assert_eq!(events[0].2["message"], *unsent);
        assert_eq!(db.scalar(&format!("SELECT count(*) FROM chat_reactions WHERE message_id = {id}")).await, 0);
        let twice = send(&app, "DELETE", &unsend_url, Some(&p.amy_token), None).await.json();
        assert_eq!(twice["message"], *unsent);
        assert!(stack.recorder.take_events().is_empty());
        send(&app, "DELETE", &format!("/api/chats/{}/messages/99999", p.conversation_id), Some(&p.amy_token), None)
            .await
            .assert_error(404, "MESSAGE_NOT_FOUND");
        // The quote now shows the message was unsent, and it cannot be quoted or reacted to.
        let listed = send(&app, "GET", &format!("/api/chats/{}/messages", p.conversation_id), Some(&p.amy_token), None)
            .await
            .json();
        let quoted = listed["messages"].as_array().unwrap().iter().find(|m| m["id"] == reply["id"]).unwrap().clone();
        assert_eq!(quoted["reply_to"], json!({"id": id, "sender_id": p.amy.id, "body": "", "is_deleted": true}));
        send(
            &app,
            "POST",
            &format!("/api/chats/{}/messages", p.conversation_id),
            Some(&p.ben_token),
            Some(json!({"body": "x", "reply_to_message_id": id})),
        )
        .await
        .assert_error(400, "REPLY_TARGET_NOT_FOUND");
        send(&app, "PUT", &reaction_url, Some(&p.ben_token), Some(json!({"emoji": "👍"})))
            .await
            .assert_error(404, "MESSAGE_NOT_FOUND");
        let reactions = send(&app, "DELETE", &reaction_url, Some(&p.ben_token), None).await.json();
        assert_eq!(reactions["reactions"], json!([]));

        // Unsent messages no longer count as unread.
        let fresh = post_message(&stack, &p.amy_token, p.conversation_id, json!({"body": "oops"})).await;
        send(
            &app,
            "DELETE",
            &format!("/api/chats/{}/messages/{}", p.conversation_id, fresh["id"]),
            Some(&p.amy_token),
            None,
        )
        .await;
        let unread = send(&app, "GET", "/api/chats/unread-count", Some(&p.ben_token), None).await.json();
        assert_eq!(unread["unread_messages"], 0);
        let inbox = send(&app, "GET", "/api/chats", Some(&p.ben_token), None).await.json();
        assert_eq!(inbox["conversations"][0]["last_message"]["is_deleted"], true);
        db.finish().await;
    });
}

#[test]
fn losing_the_follow_blocks_new_messages_but_keeps_history() {
    run(async {
        let Some(db) = TestDb::new("revoked").await else { return };
        let stack = Stack::new(&db.pool);
        let app = stack.router();
        let p = pair(&db, &stack).await;
        let msg = post_message(
            &stack,
            &p.amy_token,
            p.conversation_id,
            json!({"body": "before", "client_message_id": "keep"}),
        )
        .await;
        unfollow(&db.pool, &p.amy, &p.ben).await;

        let url = format!("/api/chats/{}/messages", p.conversation_id);
        send(&app, "POST", &url, Some(&p.ben_token), Some(json!({"body": "after"})))
            .await
            .assert_error(403, "CHAT_NOT_ALLOWED");
        send(
            &app,
            "POST",
            &format!("/api/chats/{}/typing", p.conversation_id),
            Some(&p.ben_token),
            Some(json!({"is_typing": true})),
        )
        .await
        .assert_error(403, "CHAT_NOT_ALLOWED");
        send(&app, "PUT", &format!("{url}/{}/reaction", msg["id"]), Some(&p.ben_token), Some(json!({"emoji": "👍"})))
            .await
            .assert_error(403, "CHAT_NOT_ALLOWED");
        // A retry of a message stored before the follow ended still succeeds.
        let retry =
            send(&app, "POST", &url, Some(&p.amy_token), Some(json!({"body": "before", "client_message_id": "keep"})))
                .await;
        assert_eq!((retry.status, &retry.json()["message"]), (200, &msg));

        let view =
            send(&app, "GET", &format!("/api/chats/{}", p.conversation_id), Some(&p.ben_token), None).await.json();
        assert_eq!(view["conversation"]["can_message"], false);
        let history = send(&app, "GET", &url, Some(&p.ben_token), None).await.json();
        assert_eq!(ids(&history["messages"]), vec![msg["id"].as_i64().unwrap()]);
        let reopened =
            send(&app, "POST", "/api/chats", Some(&p.ben_token), Some(json!({"user_id": p.amy.id}))).await.json();
        assert_eq!(
            (reopened["created"].as_bool(), reopened["conversation"]["id"].as_i64()),
            (Some(false), Some(p.conversation_id))
        );
        db.finish().await;
    });
}

#[test]
fn database_failures_answer_500() {
    run(async {
        let Some(db) = TestDb::new("broken").await else { return };
        let stack = Stack::new(&db.pool);
        let p = pair(&db, &stack).await;
        let broken = broken_pool().await;
        let broken_core = common::core(&broken);
        let chat = ChatContext::with_realtime(&broken_core, std::sync::Arc::new(Recorder::default()));
        let app = gt_chat::routes(&stack.core, &chat);
        let c = p.conversation_id;
        let cases: Vec<(&str, String, Option<Value>, &str)> = vec![
            ("GET", "/api/chats".into(), None, "FETCH_FAILED"),
            ("GET", "/api/chats/unread-count".into(), None, "FETCH_FAILED"),
            ("POST", "/api/chats".into(), Some(json!({"user_id": p.ben.id})), "CREATE_FAILED"),
            ("GET", format!("/api/chats/{c}"), None, "FETCH_FAILED"),
            ("GET", format!("/api/chats/{c}/messages"), None, "FETCH_FAILED"),
            ("POST", format!("/api/chats/{c}/messages"), Some(json!({"body": "x"})), "CREATE_FAILED"),
            ("DELETE", format!("/api/chats/{c}/messages/1"), None, "DELETE_FAILED"),
            ("PUT", format!("/api/chats/{c}/messages/1/reaction"), Some(json!({"emoji": "👍"})), "UPDATE_FAILED"),
            ("DELETE", format!("/api/chats/{c}/messages/1/reaction"), None, "UPDATE_FAILED"),
            ("POST", format!("/api/chats/{c}/read"), Some(json!({"message_id": 1})), "UPDATE_FAILED"),
            ("POST", format!("/api/chats/{c}/delivered"), Some(json!({"message_id": 1})), "UPDATE_FAILED"),
            ("POST", format!("/api/chats/{c}/typing"), Some(json!({"is_typing": true})), "UPDATE_FAILED"),
        ];
        for (method, uri, body, code) in cases {
            send(&app, method, &uri, Some(&p.amy_token), body).await.assert_error(500, code);
        }
        db.finish().await;
    });
}

#[test]
fn events_reach_local_connections_without_redis() {
    run(async {
        let Some(db) = TestDb::new("local_ws").await else { return };
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
        follow(&db.pool, &ben, &amy).await;
        let token = |user: &common::TestUser| core.tokens.generate(user.id, &user.username).unwrap().token;
        let (mut ws, _) =
            tokio_tungstenite::connect_async(format!("ws://{addr}/api/ws/notifications?token={}", token(&ben)))
                .await
                .unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "connected");

        let res = send(&app, "POST", "/api/chats", Some(&token(&amy)), Some(json!({"user_id": ben.id}))).await.json();
        let conversation = res["conversation"]["id"].as_i64().unwrap();
        let sent = post_message_on(&app, &token(&amy), conversation, "live!").await;
        let event = next_text(&mut ws).await;
        assert_eq!(event["type"], "chat_message");
        assert_eq!(event["payload"]["message"], sent);
        assert_eq!(next_text(&mut ws).await["type"], "chat_receipt");
        db.finish().await;
    });
}

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

async fn post_message_on(app: &axum::Router, token: &str, conversation_id: i64, body: &str) -> Value {
    let res =
        send(app, "POST", &format!("/api/chats/{conversation_id}/messages"), Some(token), Some(json!({"body": body})))
            .await;
    assert_eq!(res.status, 201, "{}", res.body);
    res.json()["message"].clone()
}
