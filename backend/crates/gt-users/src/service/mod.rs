//! Services (ports of `internal/services/{services,badge,follow,email}.go`).

mod auth;
mod badge;
mod email;
mod follow;
mod follow_events;
mod profile;
mod search;
mod streak;

pub use auth::{hash_password, verify_password, AuthError, AuthService, BCRYPT_COST};
pub use badge::BadgeService;
pub use email::{
    EmailError, EmailSender, EmailService, ResendEmailSender, SmtpEmailSender, PASSWORD_RESET_SUBJECT,
    VERIFICATION_SUBJECT,
};
pub use follow::{FollowError, FollowResult, FollowService, MutualEdge};
pub use profile::ProfileService;
pub use search::SearchSuggestionsService;
pub use streak::StreakService;
