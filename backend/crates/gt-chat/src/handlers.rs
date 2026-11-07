//! HTTP handlers of the chat routes.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::{AuthUser, QueryParams};
use gt_core::{response, ApiError, ApiResult};

use crate::dto::{
    ConversationListResponse, ConversationResponse, DeliveredResponse, MessageListResponse, MessageResponse,
    OpenConversationRequest, OpenConversationResponse, PointerRequest, ReactionRequest, ReactionsResponse,
    ReadResponse, SendMessageRequest, TypingRequest, UnreadCountResponse,
};
use crate::repository::Pointer;
use crate::rules::{self, Invalid};
use crate::service::{ChatError, ChatService, Viewer};

pub(crate) type ChatState = Arc<ChatService>;

/// Segment positions in `/api/chats/{id}/messages/{messageId}...`.
const CONVERSATION_SEGMENT: usize = 3;
const MESSAGE_SEGMENT: usize = 5;

/// `GET /api/chats?limit=&cursor=`.
pub(crate) async fn list_conversations(State(svc): State<ChatState>, user: AuthUser, query: QueryParams) -> ApiResult {
    let limit =
        rules::page_limit(query.get("limit"), c::CHAT_CONVERSATIONS_DEFAULT_LIMIT, c::CHAT_CONVERSATIONS_MAX_LIMIT)
            .map_err(invalid)?;
    let cursor = rules::decode_cursor(query.get("cursor")).map_err(invalid)?;
    let page = svc
        .list_conversations(user.user_id, cursor, limit)
        .await
        .map_err(|err| fail(err, &user, "Failed to load chats", c::ERR_CODE_FETCH_FAILED, 0))?;
    Ok(response::json(&ConversationListResponse {
        success: true,
        conversations: page.conversations,
        next_cursor: page.next_cursor,
        has_more: page.has_more,
    }))
}

/// `GET /api/chats/unread-count`.
pub(crate) async fn unread_count(State(svc): State<ChatState>, user: AuthUser) -> ApiResult {
    let (unread_conversations, unread_messages) = svc
        .unread_totals(user.user_id)
        .await
        .map_err(|err| fail(err, &user, "Failed to load unread chats", c::ERR_CODE_FETCH_FAILED, 0))?;
    Ok(response::json(&UnreadCountResponse { success: true, unread_conversations, unread_messages }))
}

/// `POST /api/chats` `{user_id}`: get-or-create the conversation with a user.
pub(crate) async fn open_conversation(
    State(svc): State<ChatState>,
    user: AuthUser,
    JsonBody(body): JsonBody<OpenConversationRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let (conversation, created) = svc
        .open_conversation(user.user_id, req.user_id)
        .await
        .map_err(|err| fail(err, &user, "Failed to open chat", c::ERR_CODE_CREATE_FAILED, 0))?;
    Ok(response::json(&OpenConversationResponse { success: true, conversation, created }))
}

/// `GET /api/chats/{id}`.
pub(crate) async fn get_conversation(State(svc): State<ChatState>, user: AuthUser, uri: Uri) -> ApiResult {
    let id = conversation_id(&uri)?;
    let conversation = svc
        .get_conversation(user.user_id, id)
        .await
        .map_err(|err| fail(err, &user, "Failed to load chat", c::ERR_CODE_FETCH_FAILED, id))?;
    Ok(response::json(&ConversationResponse { success: true, conversation }))
}

/// `GET /api/chats/{id}/messages?before=|after=&limit=`.
pub(crate) async fn list_messages(
    State(svc): State<ChatState>,
    user: AuthUser,
    uri: Uri,
    query: QueryParams,
) -> ApiResult {
    let id = conversation_id(&uri)?;
    let page = rules::message_page(query.get("before"), query.get("after")).map_err(invalid)?;
    let limit = rules::page_limit(query.get("limit"), c::CHAT_MESSAGES_DEFAULT_LIMIT, c::CHAT_MESSAGES_MAX_LIMIT)
        .map_err(invalid)?;
    let (messages, has_more) = svc
        .list_messages(user.user_id, id, page, limit)
        .await
        .map_err(|err| fail(err, &user, "Failed to load messages", c::ERR_CODE_FETCH_FAILED, id))?;
    Ok(response::json(&MessageListResponse { success: true, messages, has_more }))
}

/// `POST /api/chats/{id}/messages`: 201 when sent, 200 for a retried `client_message_id`.
pub(crate) async fn send_message(
    State(svc): State<ChatState>,
    user: AuthUser,
    uri: Uri,
    JsonBody(body): JsonBody<SendMessageRequest>,
) -> ApiResult {
    let id = conversation_id(&uri)?;
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let viewer = Viewer { id: user.user_id, username: &user.username };
    let (message, created) = svc
        .send_message(viewer, id, &req)
        .await
        .map_err(|err| fail(err, &user, "Failed to send message", c::ERR_CODE_CREATE_FAILED, id))?;
    let status = if created { StatusCode::CREATED } else { StatusCode::OK };
    Ok(response::json_status(status, &MessageResponse { success: true, message }))
}

/// `DELETE /api/chats/{id}/messages/{messageId}`: unsend.
pub(crate) async fn unsend_message(State(svc): State<ChatState>, user: AuthUser, uri: Uri) -> ApiResult {
    let (id, message_id) = message_ids(&uri)?;
    let message = svc
        .unsend_message(user.user_id, id, message_id)
        .await
        .map_err(|err| fail(err, &user, "Failed to unsend message", c::ERR_CODE_DELETE_FAILED, id))?;
    Ok(response::json(&MessageResponse { success: true, message }))
}

/// `PUT /api/chats/{id}/messages/{messageId}/reaction` `{emoji}`.
pub(crate) async fn set_reaction(
    State(svc): State<ChatState>,
    user: AuthUser,
    uri: Uri,
    JsonBody(body): JsonBody<ReactionRequest>,
) -> ApiResult {
    let (id, message_id) = message_ids(&uri)?;
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let reactions = svc
        .set_reaction(user.user_id, id, message_id, &req.emoji)
        .await
        .map_err(|err| fail(err, &user, "Failed to react", c::ERR_CODE_UPDATE_FAILED, id))?;
    Ok(response::json(&ReactionsResponse { success: true, message_id, reactions }))
}

/// `DELETE /api/chats/{id}/messages/{messageId}/reaction`.
pub(crate) async fn remove_reaction(State(svc): State<ChatState>, user: AuthUser, uri: Uri) -> ApiResult {
    let (id, message_id) = message_ids(&uri)?;
    let reactions = svc
        .remove_reaction(user.user_id, id, message_id)
        .await
        .map_err(|err| fail(err, &user, "Failed to remove reaction", c::ERR_CODE_UPDATE_FAILED, id))?;
    Ok(response::json(&ReactionsResponse { success: true, message_id, reactions }))
}

/// `POST /api/chats/{id}/read` `{message_id}`.
pub(crate) async fn mark_read(
    State(svc): State<ChatState>,
    user: AuthUser,
    uri: Uri,
    JsonBody(body): JsonBody<PointerRequest>,
) -> ApiResult {
    let id = conversation_id(&uri)?;
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let last_read_message_id = svc
        .mark(user.user_id, id, req.message_id, Pointer::Read)
        .await
        .map_err(|err| fail(err, &user, "Failed to mark chat read", c::ERR_CODE_UPDATE_FAILED, id))?;
    Ok(response::json(&ReadResponse { success: true, last_read_message_id }))
}

/// `POST /api/chats/{id}/delivered` `{message_id}`.
pub(crate) async fn mark_delivered(
    State(svc): State<ChatState>,
    user: AuthUser,
    uri: Uri,
    JsonBody(body): JsonBody<PointerRequest>,
) -> ApiResult {
    let id = conversation_id(&uri)?;
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let last_delivered_message_id = svc
        .mark(user.user_id, id, req.message_id, Pointer::Delivered)
        .await
        .map_err(|err| fail(err, &user, "Failed to mark chat delivered", c::ERR_CODE_UPDATE_FAILED, id))?;
    Ok(response::json(&DeliveredResponse { success: true, last_delivered_message_id }))
}

/// `POST /api/chats/{id}/typing` `{is_typing}`.
pub(crate) async fn typing(
    State(svc): State<ChatState>,
    user: AuthUser,
    uri: Uri,
    JsonBody(body): JsonBody<TypingRequest>,
) -> ApiResult {
    let id = conversation_id(&uri)?;
    let req = body.map_err(|_| ApiError::invalid_request())?;
    svc.typing(user.user_id, id, req.is_typing)
        .await
        .map_err(|err| fail(err, &user, "Failed to send typing status", c::ERR_CODE_UPDATE_FAILED, id))?;
    Ok(response::success(""))
}

// ==================== Helpers ====================

fn segment(uri: &Uri, index: usize) -> &str {
    uri.path().split('/').nth(index).unwrap_or_default()
}

fn conversation_id(uri: &Uri) -> Result<i64, ApiError> {
    rules::parse_id(segment(uri, CONVERSATION_SEGMENT))
        .ok_or_else(|| ApiError::bad_request("Invalid conversation ID", c::ERR_CODE_INVALID_REQUEST))
}

fn message_ids(uri: &Uri) -> Result<(i64, i64), ApiError> {
    let conversation = conversation_id(uri)?;
    let message = rules::parse_id(segment(uri, MESSAGE_SEGMENT))
        .ok_or_else(|| ApiError::bad_request("Invalid message ID", c::ERR_CODE_INVALID_REQUEST))?;
    Ok((conversation, message))
}

fn invalid(invalid: Invalid) -> ApiError {
    ApiError::bad_request(invalid.message, invalid.code)
}

/// Maps a service error to its response; unexpected errors are logged and answered with
/// `fail_message`/`fail_code` and status 500.
fn fail(err: ChatError, user: &AuthUser, fail_message: &str, fail_code: &str, conversation_id: i64) -> ApiError {
    if let Some(api) = err.api_error() {
        return api;
    }
    tracing::error!(
        user_id = user.user_id,
        conversation_id,
        error = format!("{err:#}"),
        action = "responded with 500; the client may retry",
        "{fail_message}"
    );
    ApiError::internal(fail_message, fail_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_ids() {
        let uri: Uri = "/api/chats/12/messages/34/reaction".parse().unwrap();
        assert_eq!(conversation_id(&uri).unwrap(), 12);
        assert_eq!(message_ids(&uri).unwrap(), (12, 34));
        let bad: Uri = "/api/chats/x/messages/34".parse().unwrap();
        assert_eq!(conversation_id(&bad).unwrap_err().message, "Invalid conversation ID");
        let bad: Uri = "/api/chats/1/messages/0".parse().unwrap();
        assert_eq!(message_ids(&bad).unwrap_err().message, "Invalid message ID");
        let short: Uri = "/api/chats".parse().unwrap();
        assert!(conversation_id(&short).is_err());
    }
}
