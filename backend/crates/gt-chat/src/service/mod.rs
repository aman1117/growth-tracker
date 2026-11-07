//! [`ChatService`]: membership and permission checks, storage, and real-time fan-out.

mod error;
mod hydrate;

use std::collections::HashMap;
use std::sync::Arc;

use gt_notify::push::PushRequest;
use serde::Serialize;
use serde_json::json;

pub use error::ChatError;
use hydrate::{group_reactions, message_dto, unknown_user_dto, user_dto};

use crate::dto::{
    ConversationDto, MessageDto, MessageEvent, ReactionDto, ReactionEvent, ReceiptEvent, SendMessageRequest,
    TypingEvent, EVENT_MESSAGE, EVENT_MESSAGE_DELETED, EVENT_REACTION, EVENT_RECEIPT, EVENT_TYPING,
};
use crate::realtime::ChatRealtime;
use crate::repository::{ChatRepository, Conversation, InboxCursor, Member, Message, NewMessage, Pointer};
use crate::rules::{self, format_time, Invalid, MessagePage};

/// Push type of new messages (the client groups and opens them by it).
pub const PUSH_TYPE_CHAT_MESSAGE: &str = "chat_message";
/// Pushes stay deliverable for a day (devices offline overnight still get them).
const CHAT_PUSH_TTL_SECONDS: i64 = 86_400;

/// The caller of a chat operation.
#[derive(Debug, Clone, Copy)]
pub struct Viewer<'a> {
    pub id: i64,
    pub username: &'a str,
}

/// One page of the inbox.
#[derive(Debug)]
pub struct ConversationPage {
    pub conversations: Vec<ConversationDto>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

/// Direct messaging between two users.
pub struct ChatService {
    repo: Arc<ChatRepository>,
    realtime: Arc<dyn ChatRealtime>,
}

impl std::fmt::Debug for ChatService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatService").field("repo", &self.repo).finish_non_exhaustive()
    }
}

impl ChatService {
    pub fn new(repo: Arc<ChatRepository>, realtime: Arc<dyn ChatRealtime>) -> Self {
        Self { repo, realtime }
    }

    // ==================== Conversations ====================

    /// The viewer's conversations with at least one message, latest activity first. Listing
    /// means the viewer's device received the latest messages, so each listed conversation is
    /// marked delivered (best-effort).
    pub async fn list_conversations(
        &self,
        viewer: i64,
        cursor: Option<InboxCursor>,
        limit: i64,
    ) -> Result<ConversationPage, ChatError> {
        let mut rows = self.repo.list_conversations(viewer, cursor, limit + 1).await?;
        let has_more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        let next_cursor = rows
            .last()
            .filter(|_| has_more)
            .map(|c| rules::encode_cursor(InboxCursor { updated_at: c.updated_at, id: c.id }));
        let members = self.repo.members(&rows.iter().map(|c| c.id).collect::<Vec<_>>()).await?;
        let conversations = self.conversation_dtos(viewer, &rows, &members).await?;
        self.mark_listed_delivered(viewer, &rows, &members).await;
        Ok(ConversationPage { conversations, next_cursor, has_more })
    }

    /// One conversation of the viewer.
    pub async fn get_conversation(&self, viewer: i64, conversation_id: i64) -> Result<ConversationDto, ChatError> {
        let conversation = self.member_conversation(viewer, conversation_id).await?;
        self.single_dto(viewer, conversation).await
    }

    /// The viewer's conversation with `user_id`, created when missing (which requires
    /// permission to message them). The flag tells whether it was created.
    pub async fn open_conversation(&self, viewer: i64, user_id: i64) -> Result<(ConversationDto, bool), ChatError> {
        if user_id <= 0 {
            return Err(Invalid::request("user_id is required").into());
        }
        if user_id == viewer {
            return Err(ChatError::CannotMessageSelf);
        }
        if self.repo.users(&[user_id]).await?.is_empty() {
            return Err(ChatError::UserNotFound);
        }
        if let Some(existing) = self.repo.find_conversation_between(viewer, user_id).await? {
            return Ok((self.single_dto(viewer, existing).await?, false));
        }
        if !self.repo.can_message(viewer, user_id).await? {
            return Err(ChatError::NotAllowed);
        }
        let (conversation, created) = self.repo.get_or_create_conversation(viewer, user_id).await?;
        if created {
            tracing::info!(
                conversation_id = conversation.id,
                user_id = viewer,
                peer_id = user_id,
                "Chat conversation created"
            );
        }
        Ok((self.single_dto(viewer, conversation).await?, created))
    }

    /// Totals for the app badge: `(conversations with unread messages, unread messages)`.
    pub async fn unread_totals(&self, viewer: i64) -> Result<(i64, i64), ChatError> {
        Ok(self.repo.unread_totals(viewer).await?)
    }

    // ==================== Messages ====================

    /// A page of messages, oldest first, and whether more exist in the paging direction.
    pub async fn list_messages(
        &self,
        viewer: i64,
        conversation_id: i64,
        page: MessagePage,
        limit: i64,
    ) -> Result<(Vec<MessageDto>, bool), ChatError> {
        let conversation = self.member_conversation(viewer, conversation_id).await?;
        let mut rows = match page {
            MessagePage::Before(before) => self.repo.messages_before(conversation.id, before, limit + 1).await?,
            MessagePage::After(after) => self.repo.messages_after(conversation.id, after, limit + 1).await?,
        };
        let has_more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        if matches!(page, MessagePage::Before(_)) {
            rows.reverse();
        }
        Ok((self.message_dtos(&rows).await?, has_more))
    }

    /// Sends a message. With a `client_message_id` already used by the sender, the stored
    /// message is returned instead (`false`: not created), so retries never duplicate.
    pub async fn send_message(
        &self,
        viewer: Viewer<'_>,
        conversation_id: i64,
        req: &SendMessageRequest,
    ) -> Result<(MessageDto, bool), ChatError> {
        let body = rules::normalize_body(&req.body)?;
        let client_id = rules::normalize_client_message_id(req.client_message_id.as_deref())?;
        let conversation = self.member_conversation(viewer.id, conversation_id).await?;
        if let Some(client_id) = client_id.as_deref() {
            if let Some(existing) = self.repo.find_message_by_client_id(viewer.id, client_id).await? {
                return self.existing_send(&conversation, existing).await;
            }
        }
        let peer = conversation.peer_of(viewer.id);
        if !self.repo.can_message(viewer.id, peer).await? {
            return Err(ChatError::NotAllowed);
        }
        let reply_to = match req.reply_to_message_id {
            None => None,
            Some(id) => Some(self.reply_target(conversation.id, id).await?),
        };
        let new = NewMessage {
            conversation_id: conversation.id,
            sender_id: viewer.id,
            body: &body,
            reply_to_message_id: reply_to,
            client_message_id: client_id.as_deref(),
        };
        let Some(message) = self.repo.insert_message(new).await? else {
            // A concurrent retry with the same client id won the insert.
            let existing = self
                .repo
                .find_message_by_client_id(viewer.id, client_id.as_deref().unwrap_or_default())
                .await?
                .ok_or_else(|| anyhow::anyhow!("message with a duplicate client id vanished"))?;
            return self.existing_send(&conversation, existing).await;
        };
        let dto = self.message_dtos(std::slice::from_ref(&message)).await?.remove(0);
        tracing::info!(
            conversation_id = conversation.id,
            message_id = message.id,
            sender_id = viewer.id,
            "Chat message sent"
        );

        let members = [viewer.id, peer];
        self.emit(&members, EVENT_MESSAGE, &MessageEvent { conversation_id: conversation.id, message: &dto }).await;
        // Sending implies the sender read everything before it (their pointers moved).
        let receipt = ReceiptEvent {
            conversation_id: conversation.id,
            user_id: viewer.id,
            last_read_message_id: message.id,
            last_delivered_message_id: message.id,
        };
        self.emit(&members, EVENT_RECEIPT, &receipt).await;
        self.push_if_offline(viewer, peer, &message).await;
        Ok((dto, true))
    }

    /// Unsends the viewer's own message for everyone (idempotent).
    pub async fn unsend_message(
        &self,
        viewer: i64,
        conversation_id: i64,
        message_id: i64,
    ) -> Result<MessageDto, ChatError> {
        let conversation = self.member_conversation(viewer, conversation_id).await?;
        let message = self.repo.find_message(conversation.id, message_id).await?.ok_or(ChatError::MessageNotFound)?;
        if message.sender_id != viewer {
            return Err(ChatError::NotSender);
        }
        if message.is_deleted {
            return Ok(self.message_dtos(&[message]).await?.remove(0));
        }
        let unsent = match self.repo.unsend(message.id).await? {
            Some(unsent) => unsent,
            // Unsent concurrently: report the stored state without a second event.
            None => {
                let current =
                    self.repo.find_message(conversation.id, message_id).await?.ok_or(ChatError::MessageNotFound)?;
                return Ok(self.message_dtos(&[current]).await?.remove(0));
            }
        };
        let dto = self.message_dtos(&[unsent]).await?.remove(0);
        tracing::info!(conversation_id = conversation.id, message_id, sender_id = viewer, "Chat message unsent");
        let members = [viewer, conversation.peer_of(viewer)];
        self.emit(&members, EVENT_MESSAGE_DELETED, &MessageEvent { conversation_id: conversation.id, message: &dto })
            .await;
        Ok(dto)
    }

    // ==================== Reactions ====================

    /// Sets (or replaces) the viewer's reaction; returns the message's reactions.
    pub async fn set_reaction(
        &self,
        viewer: i64,
        conversation_id: i64,
        message_id: i64,
        emoji: &str,
    ) -> Result<Vec<ReactionDto>, ChatError> {
        let emoji = rules::validate_emoji(emoji)?;
        let conversation = self.member_conversation(viewer, conversation_id).await?;
        let message = self.repo.find_message(conversation.id, message_id).await?;
        if message.is_none_or(|m| m.is_deleted) {
            return Err(ChatError::MessageNotFound);
        }
        if !self.repo.can_message(viewer, conversation.peer_of(viewer)).await? {
            return Err(ChatError::NotAllowed);
        }
        if !self.repo.upsert_reaction(message_id, viewer, &emoji).await? {
            return Err(ChatError::MessageNotFound);
        }
        self.reactions_changed(viewer, &conversation, message_id).await
    }

    /// Removes the viewer's reaction (idempotent); returns the message's reactions.
    pub async fn remove_reaction(
        &self,
        viewer: i64,
        conversation_id: i64,
        message_id: i64,
    ) -> Result<Vec<ReactionDto>, ChatError> {
        let conversation = self.member_conversation(viewer, conversation_id).await?;
        self.repo.find_message(conversation.id, message_id).await?.ok_or(ChatError::MessageNotFound)?;
        if !self.repo.delete_reaction(message_id, viewer).await? {
            return self.reactions_of(message_id).await;
        }
        self.reactions_changed(viewer, &conversation, message_id).await
    }

    // ==================== Receipts and typing ====================

    /// Moves the viewer's read (and delivered) or delivered pointer forward to `message_id`;
    /// returns the pointer's value.
    pub async fn mark(
        &self,
        viewer: i64,
        conversation_id: i64,
        message_id: i64,
        pointer: Pointer,
    ) -> Result<i64, ChatError> {
        if message_id <= 0 {
            return Err(Invalid::request("message_id is required").into());
        }
        let conversation = self.member_conversation(viewer, conversation_id).await?;
        let member = match self.repo.advance_pointers(conversation.id, viewer, message_id, pointer).await? {
            Some(updated) => {
                self.emit_receipt(&conversation, &updated).await;
                updated
            }
            None => self.repo.member(conversation.id, viewer).await?.ok_or(ChatError::ConversationNotFound)?,
        };
        Ok(match pointer {
            Pointer::Read => member.last_read_message_id,
            Pointer::Delivered => member.last_delivered_message_id,
        })
    }

    /// Tells the other member the viewer started or stopped typing.
    pub async fn typing(&self, viewer: i64, conversation_id: i64, is_typing: bool) -> Result<(), ChatError> {
        let conversation = self.member_conversation(viewer, conversation_id).await?;
        let peer = conversation.peer_of(viewer);
        if !self.repo.can_message(viewer, peer).await? {
            return Err(ChatError::NotAllowed);
        }
        let event = TypingEvent { conversation_id: conversation.id, user_id: viewer, is_typing };
        self.emit(&[peer], EVENT_TYPING, &event).await;
        Ok(())
    }

    // ==================== Helpers ====================

    async fn member_conversation(&self, viewer: i64, conversation_id: i64) -> Result<Conversation, ChatError> {
        self.repo.find_conversation(conversation_id, viewer).await?.ok_or(ChatError::ConversationNotFound)
    }

    /// The id of a message of the conversation that can be replied to.
    async fn reply_target(&self, conversation_id: i64, message_id: i64) -> Result<i64, ChatError> {
        if message_id <= 0 {
            return Err(ChatError::ReplyTargetNotFound);
        }
        match self.repo.find_message(conversation_id, message_id).await? {
            Some(target) if !target.is_deleted => Ok(target.id),
            _ => Err(ChatError::ReplyTargetNotFound),
        }
    }

    async fn existing_send(
        &self,
        conversation: &Conversation,
        existing: Message,
    ) -> Result<(MessageDto, bool), ChatError> {
        if existing.conversation_id != conversation.id {
            return Err(ChatError::ClientIdConflict);
        }
        tracing::debug!(
            conversation_id = conversation.id,
            message_id = existing.id,
            "Duplicate chat send; returning the stored message"
        );
        Ok((self.message_dtos(&[existing]).await?.remove(0), false))
    }

    async fn reactions_of(&self, message_id: i64) -> Result<Vec<ReactionDto>, ChatError> {
        Ok(group_reactions(self.repo.reactions(&[message_id]).await?).remove(&message_id).unwrap_or_default())
    }

    async fn reactions_changed(
        &self,
        viewer: i64,
        conversation: &Conversation,
        message_id: i64,
    ) -> Result<Vec<ReactionDto>, ChatError> {
        let reactions = self.reactions_of(message_id).await?;
        let event = ReactionEvent { conversation_id: conversation.id, message_id, reactions: &reactions };
        self.emit(&[viewer, conversation.peer_of(viewer)], EVENT_REACTION, &event).await;
        Ok(reactions)
    }

    async fn emit_receipt(&self, conversation: &Conversation, member: &Member) {
        let event = ReceiptEvent {
            conversation_id: conversation.id,
            user_id: member.user_id,
            last_read_message_id: member.last_read_message_id,
            last_delivered_message_id: member.last_delivered_message_id,
        };
        self.emit(&[conversation.user_a_id, conversation.user_b_id], EVENT_RECEIPT, &event).await;
    }

    async fn emit<T: Serialize>(&self, users: &[i64], event_type: &str, payload: &T) {
        let value = match serde_json::to_value(payload) {
            Ok(value) => value,
            Err(err) => {
                tracing::error!(event_type, error = %err, "Failed to encode chat event; clients resync on next fetch");
                return;
            }
        };
        for &user_id in users {
            self.realtime.send(user_id, event_type, &value).await;
        }
    }

    /// Queues a Web Push for the recipient when they do not have the app open.
    async fn push_if_offline(&self, sender: Viewer<'_>, recipient: i64, message: &Message) {
        if self.realtime.is_connected(recipient).await {
            return;
        }
        let data = json!({
            "conversation_id": message.conversation_id,
            "message_id": message.id,
            "sender_id": sender.id,
            "sender_username": sender.username,
        });
        self.realtime.push(PushRequest {
            user_id: recipient,
            notification_type: PUSH_TYPE_CHAT_MESSAGE.to_string(),
            title: sender.username.to_string(),
            body: message.body.clone(),
            dedupe_key: format!("chat:{}:{}", message.conversation_id, message.id),
            deep_link: format!("/chats/{}", message.conversation_id),
            data: data.as_object().cloned(),
            ttl_seconds: CHAT_PUSH_TTL_SECONDS,
        });
    }

    /// Marks each listed conversation delivered up to its last message; failures only delay
    /// the double tick, so they are logged and ignored.
    async fn mark_listed_delivered(&self, viewer: i64, rows: &[Conversation], members: &[Member]) {
        for conversation in rows {
            let Some(last) = conversation.last_message_id else { continue };
            let delivered = members
                .iter()
                .find(|m| m.conversation_id == conversation.id && m.user_id == viewer)
                .map_or(0, |m| m.last_delivered_message_id);
            if delivered >= last {
                continue;
            }
            match self.repo.advance_pointers(conversation.id, viewer, last, Pointer::Delivered).await {
                Ok(Some(updated)) => self.emit_receipt(conversation, &updated).await,
                Ok(None) => {}
                Err(err) => tracing::warn!(
                    conversation_id = conversation.id,
                    user_id = viewer,
                    error = %err,
                    "Failed to mark chat delivered; retried on the next inbox load"
                ),
            }
        }
    }

    async fn single_dto(&self, viewer: i64, conversation: Conversation) -> Result<ConversationDto, ChatError> {
        let members = self.repo.members(&[conversation.id]).await?;
        let mut dtos = self.conversation_dtos(viewer, std::slice::from_ref(&conversation), &members).await?;
        Ok(dtos.remove(0))
    }

    /// Hydrates messages with their reply previews and reactions.
    async fn message_dtos(&self, rows: &[Message]) -> Result<Vec<MessageDto>, ChatError> {
        let reply_ids: Vec<i64> = rows.iter().filter_map(|m| m.reply_to_message_id).collect();
        let replies: HashMap<i64, Message> =
            self.repo.messages_by_ids(&reply_ids).await?.into_iter().map(|m| (m.id, m)).collect();
        let live_ids: Vec<i64> = rows.iter().filter(|m| !m.is_deleted).map(|m| m.id).collect();
        let reactions = group_reactions(self.repo.reactions(&live_ids).await?);
        Ok(rows.iter().map(|m| message_dto(m, &replies, &reactions)).collect())
    }

    async fn conversation_dtos(
        &self,
        viewer: i64,
        rows: &[Conversation],
        members: &[Member],
    ) -> Result<Vec<ConversationDto>, ChatError> {
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<i64> = rows.iter().map(|c| c.id).collect();
        let peer_ids: Vec<i64> = rows.iter().map(|c| c.peer_of(viewer)).collect();
        let users: HashMap<i64, _> = self.repo.users(&peer_ids).await?.into_iter().map(|u| (u.id, u)).collect();
        let last_ids: Vec<i64> = rows.iter().filter_map(|c| c.last_message_id).collect();
        let last_rows = self.repo.messages_by_ids(&last_ids).await?;
        let last_messages: HashMap<i64, MessageDto> =
            self.message_dtos(&last_rows).await?.into_iter().map(|m| (m.id, m)).collect();
        let unread = self.repo.unread_counts(viewer, &ids).await?;
        let messageable = self.repo.messageable_peers(viewer, &peer_ids).await?;
        let pointers = |conversation_id: i64, user_id: i64| {
            members
                .iter()
                .find(|m| m.conversation_id == conversation_id && m.user_id == user_id)
                .map_or((0, 0), |m| (m.last_read_message_id, m.last_delivered_message_id))
        };

        Ok(rows
            .iter()
            .map(|c| {
                let peer_id = c.peer_of(viewer);
                let (my_read, _) = pointers(c.id, viewer);
                let (peer_read, peer_delivered) = pointers(c.id, peer_id);
                ConversationDto {
                    id: c.id,
                    peer: users.get(&peer_id).map_or_else(|| unknown_user_dto(peer_id), user_dto),
                    last_message: c.last_message_id.and_then(|id| last_messages.get(&id).cloned()),
                    unread_count: unread.get(&c.id).copied().unwrap_or(0),
                    my_last_read_message_id: my_read,
                    peer_last_read_message_id: peer_read,
                    peer_last_delivered_message_id: peer_delivered,
                    can_message: messageable.contains(&peer_id),
                    created_at: format_time(&c.created_at),
                    updated_at: format_time(&c.updated_at),
                }
            })
            .collect())
    }
}
