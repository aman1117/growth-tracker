//! Routes of the chat feature.

use axum::routing::{get, post, put};
use axum::Router;
use gt_core::CoreContext;

use crate::context::ChatContext;
use crate::handlers;

/// Every chat route (all authenticated). Reads use the API limiter, sends and unsends the
/// chat send limiter (60/min per user), and typing, receipts and reactions the chat signal
/// limiter (180/min per user). The guards are route layers, so a method without a handler gets
/// the server's 405 without authentication.
///
/// | Method   | Path                                              | Guard       |
/// |----------|---------------------------------------------------|-------------|
/// | `GET`    | `/api/chats`                                      | api         |
/// | `POST`   | `/api/chats`                                      | api         |
/// | `GET`    | `/api/chats/unread-count`                         | api         |
/// | `GET`    | `/api/chats/{id}`                                 | api         |
/// | `GET`    | `/api/chats/{id}/messages`                        | api         |
/// | `POST`   | `/api/chats/{id}/messages`                        | chat send   |
/// | `DELETE` | `/api/chats/{id}/messages/{messageId}`            | chat send   |
/// | `PUT`    | `/api/chats/{id}/messages/{messageId}/reaction`   | chat signal |
/// | `DELETE` | `/api/chats/{id}/messages/{messageId}/reaction`   | chat signal |
/// | `POST`   | `/api/chats/{id}/read`                            | chat signal |
/// | `POST`   | `/api/chats/{id}/delivered`                       | chat signal |
/// | `POST`   | `/api/chats/{id}/typing`                          | chat signal |
pub fn routes(core: &CoreContext, chat: &ChatContext) -> Router {
    let guards = &core.guards;
    let api = guards.api();
    let send = guards.auth_limited(&guards.limiters.chat_send);
    let signal = guards.auth_limited(&guards.limiters.chat_signal);

    Router::new()
        .route(
            "/api/chats",
            get(handlers::list_conversations)
                .route_layer(api.clone())
                .merge(post(handlers::open_conversation).route_layer(api.clone())),
        )
        .route("/api/chats/unread-count", get(handlers::unread_count).route_layer(api.clone()))
        .route("/api/chats/{id}", get(handlers::get_conversation).route_layer(api.clone()))
        .route(
            "/api/chats/{id}/messages",
            get(handlers::list_messages).route_layer(api).merge(post(handlers::send_message).route_layer(send.clone())),
        )
        .route(
            "/api/chats/{id}/messages/{message_id}",
            axum::routing::delete(handlers::unsend_message).route_layer(send),
        )
        .route(
            "/api/chats/{id}/messages/{message_id}/reaction",
            put(handlers::set_reaction)
                .route_layer(signal.clone())
                .merge(axum::routing::delete(handlers::remove_reaction).route_layer(signal.clone())),
        )
        .route("/api/chats/{id}/read", post(handlers::mark_read).route_layer(signal.clone()))
        .route("/api/chats/{id}/delivered", post(handlers::mark_delivered).route_layer(signal.clone()))
        .route("/api/chats/{id}/typing", post(handlers::typing).route_layer(signal))
        .with_state(chat.chat_service.clone())
}
