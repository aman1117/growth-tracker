//! SQL access to the chat tables (`chat_conversations`, `chat_members`, `chat_messages`,
//! `chat_reactions`) plus the few user and follow lookups the chat needs.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use gt_core::models::FOLLOW_STATE_ACTIVE;
use sqlx::PgPool;

/// A 1:1 conversation (`user_a_id < user_b_id`).
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct Conversation {
    pub id: i64,
    pub user_a_id: i64,
    pub user_b_id: i64,
    pub last_message_id: Option<i64>,
    pub created_at: DateTime<Utc>,
    /// Time of the last message (creation time before any message).
    pub updated_at: DateTime<Utc>,
}

impl Conversation {
    /// The other member of the conversation.
    pub fn peer_of(&self, user_id: i64) -> i64 {
        if self.user_a_id == user_id {
            self.user_b_id
        } else {
            self.user_a_id
        }
    }
}

/// A member's read and delivered pointers (message ids; 0 when none).
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::FromRow)]
pub struct Member {
    pub conversation_id: i64,
    pub user_id: i64,
    pub last_read_message_id: i64,
    pub last_delivered_message_id: i64,
}

/// A stored message. Unsent messages keep their row with an empty body.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct Message {
    pub id: i64,
    pub conversation_id: i64,
    pub sender_id: i64,
    pub body: String,
    pub reply_to_message_id: Option<i64>,
    pub client_message_id: Option<String>,
    pub is_deleted: bool,
    pub created_at: DateTime<Utc>,
}

/// One user's reaction to a message.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct Reaction {
    pub message_id: i64,
    pub user_id: i64,
    pub emoji: String,
    pub created_at: DateTime<Utc>,
}

/// The public profile fields shown in chats.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct ChatUser {
    pub id: i64,
    pub username: String,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub is_verified: bool,
}

/// A message to insert.
#[derive(Debug, Clone, Copy)]
pub struct NewMessage<'a> {
    pub conversation_id: i64,
    pub sender_id: i64,
    pub body: &'a str,
    pub reply_to_message_id: Option<i64>,
    pub client_message_id: Option<&'a str>,
}

/// Position in the inbox (ordered by last activity, then id, both descending).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InboxCursor {
    pub updated_at: DateTime<Utc>,
    pub id: i64,
}

/// Which pointer(s) to move forward.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pointer {
    Delivered,
    /// Reading also delivers.
    Read,
}

const CONVERSATION_FIELDS: &str = "id, user_a_id, user_b_id, last_message_id, created_at, updated_at";
const CONVERSATION_COLUMNS: &str = "c.id, c.user_a_id, c.user_b_id, c.last_message_id, c.created_at, c.updated_at";
const MEMBER_COLUMNS: &str = "cm.conversation_id, cm.user_id, cm.last_read_message_id, cm.last_delivered_message_id";
const MESSAGE_COLUMNS: &str =
    "m.id, m.conversation_id, m.sender_id, m.body, m.reply_to_message_id, m.client_message_id, m.is_deleted, m.created_at";

/// Orders a pair of user ids as stored (`user_a_id < user_b_id`).
pub fn ordered_pair(a: i64, b: i64) -> (i64, i64) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Chat persistence. Cheap to clone.
#[derive(Debug, Clone)]
pub struct ChatRepository {
    pool: PgPool,
}

impl ChatRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    // ==================== Conversations ====================

    /// The conversation when `member_id` belongs to it.
    pub async fn find_conversation(
        &self,
        conversation_id: i64,
        member_id: i64,
    ) -> Result<Option<Conversation>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM chat_conversations c \
             JOIN chat_members cm ON cm.conversation_id = c.id AND cm.user_id = $2 WHERE c.id = $1"
        ))
        .bind(conversation_id)
        .bind(member_id)
        .fetch_optional(&self.pool)
        .await
    }

    /// The conversation between two users, if any.
    pub async fn find_conversation_between(
        &self,
        user_id: i64,
        other_id: i64,
    ) -> Result<Option<Conversation>, sqlx::Error> {
        let (a, b) = ordered_pair(user_id, other_id);
        sqlx::query_as(&format!(
            "SELECT {CONVERSATION_FIELDS} FROM chat_conversations WHERE user_a_id = $1 AND user_b_id = $2"
        ))
        .bind(a)
        .bind(b)
        .fetch_optional(&self.pool)
        .await
    }

    /// The conversation between two distinct users, created with both memberships when missing.
    /// The flag tells whether it was created by this call. Safe under concurrent calls.
    pub async fn get_or_create_conversation(
        &self,
        user_id: i64,
        other_id: i64,
    ) -> Result<(Conversation, bool), sqlx::Error> {
        let (a, b) = ordered_pair(user_id, other_id);
        let mut tx = self.pool.begin().await?;
        let inserted: Option<Conversation> = sqlx::query_as(&format!(
            "INSERT INTO chat_conversations (user_a_id, user_b_id) VALUES ($1, $2) \
             ON CONFLICT (user_a_id, user_b_id) DO NOTHING RETURNING {CONVERSATION_FIELDS}"
        ))
        .bind(a)
        .bind(b)
        .fetch_optional(&mut *tx)
        .await?;
        let result = match inserted {
            Some(conversation) => {
                sqlx::query(
                    "INSERT INTO chat_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3) \
                     ON CONFLICT DO NOTHING",
                )
                .bind(conversation.id)
                .bind(a)
                .bind(b)
                .execute(&mut *tx)
                .await?;
                (conversation, true)
            }
            None => {
                let existing = sqlx::query_as(&format!(
                    "SELECT {CONVERSATION_FIELDS} FROM chat_conversations WHERE user_a_id = $1 AND user_b_id = $2"
                ))
                .bind(a)
                .bind(b)
                .fetch_one(&mut *tx)
                .await?;
                (existing, false)
            }
        };
        tx.commit().await?;
        Ok(result)
    }

    /// The user's conversations that have at least one message, most recent activity first.
    pub async fn list_conversations(
        &self,
        user_id: i64,
        cursor: Option<InboxCursor>,
        limit: i64,
    ) -> Result<Vec<Conversation>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM chat_members cm \
             JOIN chat_conversations c ON c.id = cm.conversation_id \
             WHERE cm.user_id = $1 AND c.last_message_id IS NOT NULL \
               AND ($2::timestamptz IS NULL OR (c.updated_at, c.id) < ($2, $3)) \
             ORDER BY c.updated_at DESC, c.id DESC LIMIT $4"
        ))
        .bind(user_id)
        .bind(cursor.map(|c| c.updated_at))
        .bind(cursor.map_or(0, |c| c.id))
        .bind(limit)
        .fetch_all(&self.pool)
        .await
    }

    // ==================== Members ====================

    /// Every membership of the given conversations.
    pub async fn members(&self, conversation_ids: &[i64]) -> Result<Vec<Member>, sqlx::Error> {
        sqlx::query_as(&format!("SELECT {MEMBER_COLUMNS} FROM chat_members cm WHERE cm.conversation_id = ANY($1)"))
            .bind(conversation_ids)
            .fetch_all(&self.pool)
            .await
    }

    pub async fn member(&self, conversation_id: i64, user_id: i64) -> Result<Option<Member>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {MEMBER_COLUMNS} FROM chat_members cm WHERE cm.conversation_id = $1 AND cm.user_id = $2"
        ))
        .bind(conversation_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
    }

    /// Moves the member's pointer(s) forward to `message_id`, clamped to the conversation's
    /// newest message; pointers never move back. `None` when nothing changed (or no such
    /// member).
    pub async fn advance_pointers(
        &self,
        conversation_id: i64,
        user_id: i64,
        message_id: i64,
        pointer: Pointer,
    ) -> Result<Option<Member>, sqlx::Error> {
        let (set, changed) = match pointer {
            Pointer::Delivered => (
                "last_delivered_message_id = GREATEST(cm.last_delivered_message_id, t.target)",
                "cm.last_delivered_message_id < t.target",
            ),
            Pointer::Read => (
                "last_delivered_message_id = GREATEST(cm.last_delivered_message_id, t.target), \
                 last_read_message_id = GREATEST(cm.last_read_message_id, t.target)",
                "(cm.last_delivered_message_id < t.target OR cm.last_read_message_id < t.target)",
            ),
        };
        sqlx::query_as(&format!(
            "UPDATE chat_members cm SET {set} \
             FROM (SELECT LEAST($3, COALESCE(c.last_message_id, 0)) AS target \
                   FROM chat_conversations c WHERE c.id = $1) t \
             WHERE cm.conversation_id = $1 AND cm.user_id = $2 AND {changed} \
             RETURNING {MEMBER_COLUMNS}"
        ))
        .bind(conversation_id)
        .bind(user_id)
        .bind(message_id)
        .fetch_optional(&self.pool)
        .await
    }

    /// Unread messages (from the other member, not unsent, after the read pointer) per
    /// conversation; conversations without unread messages are absent.
    pub async fn unread_counts(
        &self,
        user_id: i64,
        conversation_ids: &[i64],
    ) -> Result<HashMap<i64, i64>, sqlx::Error> {
        let rows: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT m.conversation_id, count(*) FROM chat_members cm \
             JOIN chat_messages m ON m.conversation_id = cm.conversation_id AND m.id > cm.last_read_message_id \
             WHERE cm.user_id = $1 AND cm.conversation_id = ANY($2) AND m.sender_id <> $1 AND NOT m.is_deleted \
             GROUP BY m.conversation_id",
        )
        .bind(user_id)
        .bind(conversation_ids)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().collect())
    }

    /// `(conversations with unread messages, unread messages)` over all the user's chats.
    pub async fn unread_totals(&self, user_id: i64) -> Result<(i64, i64), sqlx::Error> {
        sqlx::query_as(
            "SELECT count(DISTINCT m.conversation_id), count(*) FROM chat_members cm \
             JOIN chat_messages m ON m.conversation_id = cm.conversation_id AND m.id > cm.last_read_message_id \
             WHERE cm.user_id = $1 AND m.sender_id <> $1 AND NOT m.is_deleted",
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
    }

    // ==================== Messages ====================

    /// Stores a message, makes it the conversation's last message and marks it read by its
    /// sender, in one transaction. `None` when the sender already used `client_message_id`.
    pub async fn insert_message(&self, new: NewMessage<'_>) -> Result<Option<Message>, sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let inserted: Option<Message> = sqlx::query_as(&format!(
            "INSERT INTO chat_messages AS m (conversation_id, sender_id, body, reply_to_message_id, client_message_id) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sender_id, client_message_id) DO NOTHING \
             RETURNING {MESSAGE_COLUMNS}"
        ))
        .bind(new.conversation_id)
        .bind(new.sender_id)
        .bind(new.body)
        .bind(new.reply_to_message_id)
        .bind(new.client_message_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(message) = inserted else {
            tx.rollback().await?;
            return Ok(None);
        };
        sqlx::query(
            "UPDATE chat_conversations SET last_message_id = GREATEST(COALESCE(last_message_id, 0), $2), \
             updated_at = GREATEST(updated_at, $3) WHERE id = $1",
        )
        .bind(message.conversation_id)
        .bind(message.id)
        .bind(message.created_at)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE chat_members SET last_read_message_id = GREATEST(last_read_message_id, $3), \
             last_delivered_message_id = GREATEST(last_delivered_message_id, $3) \
             WHERE conversation_id = $1 AND user_id = $2",
        )
        .bind(message.conversation_id)
        .bind(message.sender_id)
        .bind(message.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(message))
    }

    pub async fn find_message_by_client_id(
        &self,
        sender_id: i64,
        client_message_id: &str,
    ) -> Result<Option<Message>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM chat_messages m WHERE m.sender_id = $1 AND m.client_message_id = $2"
        ))
        .bind(sender_id)
        .bind(client_message_id)
        .fetch_optional(&self.pool)
        .await
    }

    /// A message of the conversation (unsent ones included).
    pub async fn find_message(&self, conversation_id: i64, message_id: i64) -> Result<Option<Message>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM chat_messages m WHERE m.id = $1 AND m.conversation_id = $2"
        ))
        .bind(message_id)
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn messages_by_ids(&self, ids: &[i64]) -> Result<Vec<Message>, sqlx::Error> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(&format!("SELECT {MESSAGE_COLUMNS} FROM chat_messages m WHERE m.id = ANY($1)"))
            .bind(ids)
            .fetch_all(&self.pool)
            .await
    }

    /// Up to `limit` messages older than `before` (or the newest ones), NEWEST first.
    pub async fn messages_before(
        &self,
        conversation_id: i64,
        before: Option<i64>,
        limit: i64,
    ) -> Result<Vec<Message>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM chat_messages m \
             WHERE m.conversation_id = $1 AND ($2::bigint IS NULL OR m.id < $2) ORDER BY m.id DESC LIMIT $3"
        ))
        .bind(conversation_id)
        .bind(before)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
    }

    /// Up to `limit` messages newer than `after`, OLDEST first.
    pub async fn messages_after(
        &self,
        conversation_id: i64,
        after: i64,
        limit: i64,
    ) -> Result<Vec<Message>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM chat_messages m \
             WHERE m.conversation_id = $1 AND m.id > $2 ORDER BY m.id ASC LIMIT $3"
        ))
        .bind(conversation_id)
        .bind(after)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
    }

    /// Unsends a message: clears its body and drops its reactions. `None` when it was already
    /// unsent (or does not exist).
    pub async fn unsend(&self, message_id: i64) -> Result<Option<Message>, sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let updated: Option<Message> = sqlx::query_as(&format!(
            "UPDATE chat_messages AS m SET is_deleted = true, body = '', deleted_at = now() \
             WHERE m.id = $1 AND NOT m.is_deleted RETURNING {MESSAGE_COLUMNS}"
        ))
        .bind(message_id)
        .fetch_optional(&mut *tx)
        .await?;
        if updated.is_some() {
            sqlx::query("DELETE FROM chat_reactions WHERE message_id = $1").bind(message_id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(updated)
    }

    // ==================== Reactions ====================

    /// Every reaction to the given messages, per message oldest first.
    pub async fn reactions(&self, message_ids: &[i64]) -> Result<Vec<Reaction>, sqlx::Error> {
        if message_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(
            "SELECT message_id, user_id, emoji, created_at FROM chat_reactions WHERE message_id = ANY($1) \
             ORDER BY message_id, created_at, user_id",
        )
        .bind(message_ids)
        .fetch_all(&self.pool)
        .await
    }

    /// Sets (or replaces) the user's reaction. `false` when the message is unsent or gone.
    pub async fn upsert_reaction(&self, message_id: i64, user_id: i64, emoji: &str) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            "INSERT INTO chat_reactions (message_id, user_id, emoji) \
             SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM chat_messages WHERE id = $1 AND NOT is_deleted) \
             ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()",
        )
        .bind(message_id)
        .bind(user_id)
        .bind(emoji)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Removes the user's reaction; `false` when there was none.
    pub async fn delete_reaction(&self, message_id: i64, user_id: i64) -> Result<bool, sqlx::Error> {
        let result = sqlx::query("DELETE FROM chat_reactions WHERE message_id = $1 AND user_id = $2")
            .bind(message_id)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    // ==================== Users and permissions ====================

    pub async fn users(&self, ids: &[i64]) -> Result<Vec<ChatUser>, sqlx::Error> {
        sqlx::query_as(
            "SELECT id, username, profile_pic, profile_pic_thumb, COALESCE(is_verified, false) AS is_verified \
             FROM users WHERE id = ANY($1)",
        )
        .bind(ids)
        .fetch_all(&self.pool)
        .await
    }

    /// The subset of `peer_ids` the user may message: an active follow edge exists between
    /// them in either direction.
    pub async fn messageable_peers(&self, user_id: i64, peer_ids: &[i64]) -> Result<HashSet<i64>, sqlx::Error> {
        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT CASE WHEN follower_id = $1 THEN followee_id ELSE follower_id END \
             FROM follow_edges_by_follower WHERE state = $3 AND \
             ((follower_id = $1 AND followee_id = ANY($2)) OR (followee_id = $1 AND follower_id = ANY($2)))",
        )
        .bind(user_id)
        .bind(peer_ids)
        .bind(FOLLOW_STATE_ACTIVE)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Whether the two users may message each other.
    pub async fn can_message(&self, user_id: i64, peer_id: i64) -> Result<bool, sqlx::Error> {
        Ok(self.messageable_peers(user_id, &[peer_id]).await?.contains(&peer_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_are_ordered_and_peers_resolved() {
        assert_eq!(ordered_pair(9, 3), (3, 9));
        assert_eq!(ordered_pair(3, 9), (3, 9));
        let now = Utc::now();
        let c =
            Conversation { id: 1, user_a_id: 3, user_b_id: 9, last_message_id: None, created_at: now, updated_at: now };
        assert_eq!(c.peer_of(3), 9);
        assert_eq!(c.peer_of(9), 3);
    }
}
