//! Business errors of the challenge service (Go: the sentinel errors of
//! `services/challenge_service.go`) and their HTTP mapping (Go: `ChallengeHandler.fail`).

use gt_core::constants as c;
use gt_core::validator::ValidationError;
use gt_core::ApiError;

use crate::repository::ChallengeRepoError;

/// Why a challenge operation failed.
#[derive(Debug, thiserror::Error)]
pub enum ChallengeError {
    /// Invalid input (`INVALID_CHALLENGE` or another code).
    #[error("{0}")]
    Validation(#[from] ValidationError),
    /// Also returned to users who do not take part in the challenge, so its existence never
    /// leaks.
    #[error("challenge not found")]
    NotFound,
    #[error("challenge is full")]
    Full,
    #[error("open challenge limit reached")]
    LimitReached,
    #[error("challenge has ended")]
    Ended,
    #[error("challenge is not active")]
    NotActive,
    #[error("the creator cannot leave the challenge")]
    CreatorCannotLeave,
    #[error("challenge can no longer be deleted")]
    InProgress,
    #[error("cannot cheer yourself")]
    CannotCheerSelf,
    #[error("only the creator can delete the challenge")]
    NotCreator,
    /// Anything unexpected (database failures, ...): answered with a 500.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<sqlx::Error> for ChallengeError {
    fn from(err: sqlx::Error) -> Self {
        Self::Internal(err.into())
    }
}

impl From<ChallengeRepoError> for ChallengeError {
    /// A missing challenge under the row lock is the service's not-found error (Go:
    /// `mapLockedError`); everything else is unexpected.
    fn from(err: ChallengeRepoError) -> Self {
        match err {
            ChallengeRepoError::ChallengeNotFound => Self::NotFound,
            other => Self::Internal(other.into()),
        }
    }
}

impl ChallengeError {
    /// Wraps an unexpected error with context, like Go's `fmt.Errorf("<action>: %w", err)`.
    /// Business errors pass through unchanged.
    pub fn context(self, action: &str) -> Self {
        match self {
            Self::Internal(err) => Self::Internal(err.context(action.to_string())),
            other => other,
        }
    }

    /// The response for a business error; `None` for [`ChallengeError::Internal`], which the
    /// handler logs and answers with its own 500 message and code.
    pub fn api_error(&self) -> Option<ApiError> {
        let err = match self {
            Self::Validation(v) => ApiError::bad_request(v.message.clone(), v.code),
            Self::NotFound => ApiError::not_found("Challenge not found", c::ERR_CODE_CHALLENGE_NOT_FOUND),
            Self::Full => ApiError::conflict("This challenge is full", c::ERR_CODE_CHALLENGE_FULL),
            Self::LimitReached => ApiError::conflict(
                "You already take part in the maximum number of open challenges",
                c::ERR_CODE_CHALLENGE_LIMIT_REACHED,
            ),
            Self::Ended => ApiError::conflict("This challenge has ended", c::ERR_CODE_CHALLENGE_ENDED),
            Self::NotActive => {
                ApiError::conflict("You can only cheer while the challenge is active", c::ERR_CODE_CHALLENGE_NOT_ACTIVE)
            }
            Self::CreatorCannotLeave => {
                ApiError::conflict("The creator cannot leave the challenge", c::ERR_CODE_CREATOR_CANNOT_LEAVE)
            }
            Self::InProgress => ApiError::conflict(
                "A challenge can only be deleted before it starts or while you are its only participant",
                c::ERR_CODE_CHALLENGE_IN_PROGRESS,
            ),
            Self::CannotCheerSelf => ApiError::bad_request("You cannot cheer yourself", c::ERR_CODE_CANNOT_CHEER_SELF),
            Self::NotCreator => {
                ApiError::forbidden("Only the creator can delete this challenge", c::ERR_CODE_NOT_AUTHORIZED)
            }
            Self::Internal(_) => return None,
        };
        Some(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    #[test]
    fn maps_business_errors_like_the_go_handler() {
        let cases = [
            (ChallengeError::NotFound, StatusCode::NOT_FOUND, c::ERR_CODE_CHALLENGE_NOT_FOUND),
            (ChallengeError::Full, StatusCode::CONFLICT, c::ERR_CODE_CHALLENGE_FULL),
            (ChallengeError::LimitReached, StatusCode::CONFLICT, c::ERR_CODE_CHALLENGE_LIMIT_REACHED),
            (ChallengeError::Ended, StatusCode::CONFLICT, c::ERR_CODE_CHALLENGE_ENDED),
            (ChallengeError::NotActive, StatusCode::CONFLICT, c::ERR_CODE_CHALLENGE_NOT_ACTIVE),
            (ChallengeError::CreatorCannotLeave, StatusCode::CONFLICT, c::ERR_CODE_CREATOR_CANNOT_LEAVE),
            (ChallengeError::InProgress, StatusCode::CONFLICT, c::ERR_CODE_CHALLENGE_IN_PROGRESS),
            (ChallengeError::CannotCheerSelf, StatusCode::BAD_REQUEST, c::ERR_CODE_CANNOT_CHEER_SELF),
            (ChallengeError::NotCreator, StatusCode::FORBIDDEN, c::ERR_CODE_NOT_AUTHORIZED),
        ];
        for (err, status, code) in cases {
            let api = err.api_error().expect("business error");
            assert_eq!((api.status, api.code.as_str()), (status, code), "{err}");
        }
        let invalid = ChallengeError::from(ValidationError::new("title is bad", c::ERR_CODE_INVALID_CHALLENGE));
        let api = invalid.api_error().unwrap();
        assert_eq!((api.status, api.message.as_str()), (StatusCode::BAD_REQUEST, "title is bad"));
        assert!(ChallengeError::Internal(anyhow::anyhow!("boom")).api_error().is_none());
    }

    #[test]
    fn repository_errors_and_context() {
        assert!(matches!(ChallengeError::from(ChallengeRepoError::ChallengeNotFound), ChallengeError::NotFound));
        let err = ChallengeError::from(ChallengeRepoError::UserNotFound).context("join challenge");
        assert_eq!(format!("{err:#}"), "join challenge: user not found");
        assert!(matches!(ChallengeError::Ended.context("join challenge"), ChallengeError::Ended));
    }
}
