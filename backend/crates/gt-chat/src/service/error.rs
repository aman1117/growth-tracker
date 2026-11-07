//! Business errors of the chat and their HTTP mapping.

use gt_core::constants as c;
use gt_core::ApiError;

use crate::rules::Invalid;

/// Why a chat operation failed.
#[derive(Debug, thiserror::Error)]
pub enum ChatError {
    #[error("{}", .0.message)]
    Invalid(Invalid),
    /// Also returned to non-members, so a conversation's existence never leaks.
    #[error("conversation not found")]
    ConversationNotFound,
    #[error("message not found")]
    MessageNotFound,
    #[error("reply target not found")]
    ReplyTargetNotFound,
    #[error("only the sender can unsend a message")]
    NotSender,
    #[error("messaging this user is not allowed")]
    NotAllowed,
    #[error("cannot message yourself")]
    CannotMessageSelf,
    #[error("user not found")]
    UserNotFound,
    #[error("client_message_id already used in another conversation")]
    ClientIdConflict,
    /// Anything unexpected (database failures, ...): answered with a 500.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<sqlx::Error> for ChatError {
    fn from(err: sqlx::Error) -> Self {
        Self::Internal(err.into())
    }
}

impl From<Invalid> for ChatError {
    fn from(invalid: Invalid) -> Self {
        Self::Invalid(invalid)
    }
}

impl ChatError {
    /// The response of a business error; `None` for [`ChatError::Internal`], which the handler
    /// logs and answers with a 500.
    pub fn api_error(&self) -> Option<ApiError> {
        Some(match self {
            Self::Invalid(invalid) => ApiError::bad_request(invalid.message, invalid.code),
            Self::ConversationNotFound => {
                ApiError::not_found("Conversation not found", c::ERR_CODE_CONVERSATION_NOT_FOUND)
            }
            Self::MessageNotFound => ApiError::not_found("Message not found", c::ERR_CODE_MESSAGE_NOT_FOUND),
            Self::ReplyTargetNotFound => ApiError::bad_request(
                "The message you are replying to is no longer available",
                c::ERR_CODE_REPLY_TARGET_NOT_FOUND,
            ),
            Self::NotSender => {
                ApiError::forbidden("You can only unsend your own messages", c::ERR_CODE_MESSAGE_FORBIDDEN)
            }
            Self::NotAllowed => {
                ApiError::forbidden("You can message people you follow or who follow you", c::ERR_CODE_CHAT_NOT_ALLOWED)
            }
            Self::CannotMessageSelf => {
                ApiError::bad_request("You cannot message yourself", c::ERR_CODE_CANNOT_MESSAGE_SELF)
            }
            Self::UserNotFound => ApiError::not_found("User not found", c::ERR_CODE_USER_NOT_FOUND),
            Self::ClientIdConflict => ApiError::conflict("client_message_id was already used", c::ERR_CODE_CONFLICT),
            Self::Internal(_) => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_business_errors() {
        let cases: Vec<(ChatError, u16, &str)> = vec![
            (Invalid::request("bad").into(), 400, c::ERR_CODE_INVALID_REQUEST),
            (ChatError::ConversationNotFound, 404, c::ERR_CODE_CONVERSATION_NOT_FOUND),
            (ChatError::MessageNotFound, 404, c::ERR_CODE_MESSAGE_NOT_FOUND),
            (ChatError::ReplyTargetNotFound, 400, c::ERR_CODE_REPLY_TARGET_NOT_FOUND),
            (ChatError::NotSender, 403, c::ERR_CODE_MESSAGE_FORBIDDEN),
            (ChatError::NotAllowed, 403, c::ERR_CODE_CHAT_NOT_ALLOWED),
            (ChatError::CannotMessageSelf, 400, c::ERR_CODE_CANNOT_MESSAGE_SELF),
            (ChatError::UserNotFound, 404, c::ERR_CODE_USER_NOT_FOUND),
            (ChatError::ClientIdConflict, 409, c::ERR_CODE_CONFLICT),
        ];
        for (err, status, code) in cases {
            let api = err.api_error().unwrap();
            assert_eq!((api.status.as_u16(), api.code.as_str()), (status, code), "{err}");
        }
        assert!(ChatError::from(sqlx::Error::RowNotFound).api_error().is_none());
    }
}
